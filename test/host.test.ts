import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application, validateLanAddress } from '../src/host/application.ts';
import { AppStorage } from '../src/host/storage.ts';
import { createAppServer } from '../src/host/server.ts';
import { SimulatedDevice } from '../src/simulator/simulated-device.ts';

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'lil-deadline-host-')), storage = new AppStorage(dir), app = new Application(storage);
  const server = createAppServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { dir, storage, app, server, url,
    post: (path: string, body: unknown) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lil-Deadline': '1' }, body: JSON.stringify(body) }),
    async close() { await app.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); },
  };
}
async function waitFor(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Expected state did not arrive'); await new Promise(r => setTimeout(r, 20)); }
}

test('HTTP task CRUD, priority, pet rewards and timer changes survive restart', async () => {
  const h = await harness();
  try {
    assert.equal((await fetch(h.url + '/api/state')).status, 200);
    assert.equal((await h.post('/api/tasks/add', { title: 'Build a little habit', course: 'Personal', priority: 'high', dueAt: '2026-11-20T12:00:00Z' })).status, 200);
    const task = h.app.tasks.list('mock').find(t => t.title === 'Build a little habit')!;
    assert.equal(task.priority, 'high');
    await h.post('/api/tasks/edit', { id: task.id, title: 'Read for ten minutes', priority: 'low' });
    await h.post('/api/select', { id: task.id });
    await h.post('/api/tasks/complete', { id: task.id, completed: true });
    await h.post('/api/tasks/complete', { id: task.id, completed: true });
    assert.equal(h.app.companion.pet.xp, 10, 'repeated complete is idempotent');
    await h.post('/api/timer', { action: 'start' }); await h.post('/api/timer', { action: 'pause' });
    const restored = new Application(new AppStorage(h.dir));
    try {
      const t = restored.tasks.list('mock').find(t => t.id === task.id)!;
      assert.equal(t.title, 'Read for ten minutes'); assert.equal(t.priority, 'low'); assert.equal(t.done, true);
      assert.equal(restored.companion.selectedId, task.id); assert.equal(restored.companion.pet.xp, 10);
      assert.equal(restored.companion.timer.startedAt, null); assert.ok(restored.companion.timer.remainingMs < 1500000);
    } finally { await restored.dispose(); }
    await h.post('/api/tasks/complete', { id: task.id, completed: false });
    assert.equal(h.app.tasks.list('mock').find(t => t.id === task.id)!.done, false);
    assert.equal((await h.post('/api/tasks/delete', { id: task.id })).status, 200);
    assert.ok(!h.app.tasks.list('mock').some(t => t.id === task.id));
  } finally { await h.close(); }
});

test('host protects origins, validates input, and separates private credentials', async () => {
  const h = await harness();
  try {
    assert.equal((await fetch(h.url + '/api/state', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      request(h.url + '/api/state', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject).end();
    });
    assert.equal(forgedHostStatus, 403);
    assert.equal((await fetch(h.url + '/api/tasks/reset', { method: 'POST' })).status, 403);
    assert.equal((await h.post('/api/tasks/add', { title: '' })).status, 400);
    assert.equal((await h.post('/api/tasks/add', { title: 'x', priority: 'invalid' })).status, 400);
    assert.equal((await h.post('/api/settings/device', { address: 'http://example.com/private' })).status, 400);
    const token = randomBytes(32).toString('hex');
    const r = await h.post('/api/settings/device', { address: '127.0.0.1:8181', token }); assert.equal(r.status, 200);
    assert.ok(!(await r.text()).includes(token));
    assert.ok(!readFileSync(h.storage.settingsPath, 'utf8').includes(token));
    assert.equal(h.storage.loadDeviceToken(), token);
    assert.equal((await h.post('/api/settings/device', { address: '', clearToken: true })).status, 200);
    assert.equal(h.storage.loadDeviceToken(), null);
    await assert.rejects(validateLanAddress('ws://8.8.8.8:81/'), /private LAN/);
  } finally { await h.close(); }
});

test('HTTP binary frames reach simulated device; reconnect discards old frames and keeps one renderer', async () => {
  const h = await harness(), token = randomBytes(32).toString('hex');
  const device = new SimulatedDevice({ token, environmentKind: 'none', imuPresent: false });
  const address = await device.start();
  const owner = randomUUID(), another = randomUUID(), frame = Buffer.alloc(240 * 320 * 4);
  for (let i = 0; i < frame.length; i += 4) { frame[i] = 255; frame[i + 3] = 255; }
  const upload = (id: string, bytes = frame) => fetch(h.url + '/api/frame', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Lil-Deadline': '1', 'X-Renderer-Id': id }, body: bytes });
  try {
    await h.post('/api/settings/device', { address, token }); await h.post('/api/device/connect', {});
    await waitFor(() => h.app.device.diagnostics().connection.phase === 'ready');
    assert.equal((await upload(owner, Buffer.alloc(1))).status, 400);
    assert.equal((await upload(owner)).status, 200);
    await waitFor(() => device.stats.framesCompleted === 1);
    assert.deepEqual([...device.displayed!.subarray(0, 2)], [0, 248]);
    assert.equal((await upload(another)).status, 409);
    assert.equal(h.app.device.diagnostics().sensors.imu.status, 'unavailable');
    assert.equal(h.app.device.diagnostics().sensors.environment.status, 'unavailable');
    device.dropConnections(); await waitFor(() => h.app.device.diagnostics().connection.phase === 'retrying');
    assert.equal(h.app.snapshot().render.fresh, false);
    await waitFor(() => h.app.device.diagnostics().connection.phase === 'ready');
    await new Promise(r => setTimeout(r, 250)); assert.equal(device.stats.framesCompleted, 1, 'old render was not replayed');
    await upload(owner); await waitFor(() => device.stats.framesCompleted === 2);
    await h.post('/api/device/disconnect', {}); assert.equal(h.app.device.diagnostics().connection.phase, 'stopped');
    await new Promise(r => setTimeout(r, 300)); assert.equal(device.stats.authenticated, 2);
  } finally { await h.close(); await device.stop(); }
});
