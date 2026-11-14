import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application, validateLanAddress } from '../src/host/application.ts';
import { AppStorage } from '../src/host/storage.ts';
import { createAppServer } from '../src/host/server.ts';
import { SimulatedDevice } from '../src/simulator/simulated-device.ts';
import { startMockCanvas, FAKE_CANVAS_TOKEN } from './helpers/mock-canvas-server.ts';

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'lil-deadline-host-')), storage = new AppStorage(dir), app = new Application(storage);
  const root = join(dir, 'public'); mkdirSync(root);
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Lil Deadline test dashboard</title>');
  const server = createAppServer(app, { root }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
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

// node:http preserves browser navigation metadata; fetch sets Sec-Fetch-Mode to cors.
async function browserRequest(url: string, options: RequestOptions = {}) {
  return new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    request(url, options, response => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      response.on('error', reject);
    }).on('error', reject).end();
  });
}
const navigationHeaders = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };

test('Spotify routes expose only the authorization URL and reject an unmatched callback', async () => {
  const h = await harness();
  try {
    assert.equal((await h.post('/api/spotify/authorize', {})).status, 400);
    assert.equal((await h.post('/api/settings/spotify', { clientId: 'a'.repeat(32) })).status, 200);
    const authorization = await (await h.post('/api/spotify/authorize', {})).json() as { url: string };
    const url = new URL(authorization.url);
    assert.equal(url.searchParams.get('redirect_uri'), h.url + '/api/spotify/callback');
    assert.ok(url.searchParams.get('code_challenge'));
    const callback = await fetch(h.url + '/api/spotify/callback?code=forged&state=forged', { redirect: 'manual',
      headers: { Origin: 'https://accounts.spotify.com', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/?spotify=error');
    const landing = await browserRequest(h.url + callback.headers.get('location'), { headers: navigationHeaders });
    assert.equal(landing.status, 200);
    assert.match(landing.body, /Lil Deadline test dashboard/);
    const snapshot = await (await fetch(h.url + '/api/state')).text();
    assert.ok(!snapshot.includes('code_verifier'));
    assert.ok(!snapshot.includes('forged'));
    assert.equal((await h.post('/api/display/slide', { direction: 'next' })).status, 200);
    assert.equal(h.app.companion.displaySlide, 'tasks');
    assert.equal((await h.post('/api/display/slide', { slide: 'sensors' })).status, 200);
    assert.equal(h.app.companion.displaySlide, 'sensors');
    assert.equal((await h.post('/api/display/slide', { slide: 'invalid' })).status, 400);
    assert.equal(h.app.companion.displaySlide, 'sensors');
  } finally { await h.close(); }
});

test('cross-site Spotify callback navigation is accepted while other API routes stay local', async () => {
  const h = await harness();
  try {
    h.app.spotify.callback = async (params, origin) => {
      assert.equal(params.get('code'), 'test-code');
      assert.equal(origin, h.url);
    };
    const headers = { ...navigationHeaders, Origin: 'https://accounts.spotify.com' };
    const callback = await browserRequest(h.url + '/api/spotify/callback?code=test-code&state=test-state', { headers });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.location, '/?spotify=connected');
    for (const landingHeaders of [navigationHeaders, headers, { ...navigationHeaders, Origin: 'null' }]) {
      const landing = await browserRequest(h.url + callback.headers.location, { headers: landingHeaders });
      assert.equal(landing.status, 200);
      assert.match(landing.headers['content-type'] ?? '', /text\/html/);
      assert.match(landing.body, /Lil Deadline test dashboard/);
      assert.equal(landing.headers['x-frame-options'], 'DENY');
      assert.equal(landing.headers['referrer-policy'], 'no-referrer');
    }
    assert.equal((await browserRequest(h.url + '/', { headers })).status, 200);
    assert.equal((await browserRequest(h.url + '/api/state', { headers })).status, 403);
    assert.equal((await browserRequest(h.url + '/api/spotify/authorize', { method: 'POST', headers: { ...headers, 'X-Lil-Deadline': '1' } })).status, 403);
    assert.equal((await fetch(h.url + '/api/state', { headers: { Origin: h.url, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  } finally { await h.close(); }
});

test('cross-site dashboard navigation does not permit fetches, embedding, writes, or forged hosts', async () => {
  const h = await harness();
  try {
    const headers = { ...navigationHeaders, Origin: 'https://untrusted.example' };
    const cases: RequestOptions[] = [
      { headers: { ...headers, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } },
      { headers: { ...headers, 'Sec-Fetch-Mode': 'no-cors' } },
      { headers: { ...headers, 'Sec-Fetch-Dest': 'iframe' } },
      { headers: { ...headers, 'Sec-Fetch-Dest': 'object' } },
      { headers: { Origin: headers.Origin } },
      { headers: { ...headers, Host: 'evil.example' } },
      { method: 'POST', headers },
    ];
    for (const options of cases) {
      assert.equal((await browserRequest(h.url + '/?spotify=connected', options)).status, 403, JSON.stringify(options));
    }
  } finally { await h.close(); }
});

test('cover bytes are served only through the protected local artwork route', async () => {
  const h = await harness();
  const id = 'a'.repeat(64), bytes = Buffer.from([137, 80, 78, 71]);
  const path = '/api/spotify/artwork?id=' + id;
  let calls = 0;
  h.app.spotify.artwork.get = async key => { calls++; return key === id ? { bytes, contentType: 'image/png' } : null; };
  try {
    const response = await fetch(h.url + path);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal((await fetch(h.url + path, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal(calls, 1, 'cross-site calls never reach the image fetcher');
    assert.equal((await fetch(h.url + '/api/spotify/artwork?id=old')).status, 404);
  } finally { await h.close(); }
});

test('Canvas accepts token-only updates after the school address is saved once', async () => {
  const h = await harness();
  const mock = await startMockCanvas({ handler: () => ({ body: [] }) });
  try {
    assert.equal((await h.post('/api/settings/canvas', { token: FAKE_CANVAS_TOKEN })).status, 400);
    assert.equal(h.storage.loadCanvasPersonalToken(), null);
    assert.equal((await h.post('/api/settings/canvas', { baseUrl: mock.origin })).status, 200);
    const saved = await h.post('/api/settings/canvas', { token: FAKE_CANVAS_TOKEN });
    assert.equal(saved.status, 200);
    assert.ok(!(await saved.text()).includes(FAKE_CANVAS_TOKEN), 'API response must not expose the token');
    assert.equal(h.storage.loadSettings().canvas.baseUrl, mock.origin);
    assert.equal(h.storage.loadCanvasPersonalToken(), FAKE_CANVAS_TOKEN);
    await waitFor(() => h.app.canvasSync.status().snapshot !== null);
    assert.ok(mock.requests.some(r => r.path === '/api/v1/planner/items'));
    assert.deepEqual(mock.violations, []);
    assert.equal((await h.post('/api/settings/canvas', { baseUrl: 'https://other.example.edu' })).status, 400);
    assert.equal(h.storage.loadSettings().canvas.baseUrl, mock.origin);
    assert.equal((await h.post('/api/settings/canvas', { clearToken: true })).status, 200);
    assert.equal(h.storage.loadCanvasPersonalToken(), null);
    assert.equal(h.storage.loadSettings().canvas.baseUrl, mock.origin);
  } finally { await h.close(); await mock.close(); }
});

test('Canvas accepts a pasted tilde token with surrounding whitespace and sends only the cleaned Bearer token', async () => {
  const h = await harness();
  const token = '12345~FakeCanvasTokenForTestsOnly_0123456789';
  const mock = await startMockCanvas({ tokens: [token], handler: () => ({ body: [] }) });
  try {
    const response = await h.post('/api/settings/canvas', { baseUrl: mock.origin, token: `\r\n\u200b ${token}\u2060 \n` });
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes(token));
    assert.equal(h.storage.loadCanvasPersonalToken(), token);
    await waitFor(() => h.app.canvasSync.status().snapshot !== null && !h.app.canvasSync.status().refreshing);
    assert.ok(mock.requests.length > 0);
    assert.deepEqual(mock.violations, []);
    const bad = await h.post('/api/settings/canvas', { token: '12345~fake token' });
    assert.equal(bad.status, 400);
    const error = (await bad.json() as { error: string }).error;
    assert.match(error, /spaces or line breaks/);
    assert.ok(!error.includes('12345~fake token'));
    assert.equal(h.storage.loadCanvasPersonalToken(), token);
    assert.equal((await h.post('/api/settings/canvas', { token: ' \r\n' })).status, 200);
    assert.equal(h.storage.loadCanvasPersonalToken(), token, 'blank replacement keeps the saved token');
  } finally { await h.close(); await mock.close(); }
});

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
