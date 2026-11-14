import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../src/host/application.ts';
import { AppStorage } from '../src/host/storage.ts';
import { createAppServer, isNgrokHost } from '../src/host/server.ts';

test('isNgrokHost accepts ngrok tunnel subdomains only', () => {
  for (const host of ['abc-123.ngrok-free.app', 'Demo.NGROK-FREE.APP', 'x.ngrok.app', 'x.ngrok-free.dev', 'x.ngrok.io', 'x.ngrok-free.app:443']) assert.ok(isNgrokHost(host), host);
  for (const host of ['', 'ngrok-free.app', '.ngrok-free.app', 'evil.com', 'ngrok-free.app.evil.com', 'x.ngrok-free.app.evil.com', 'x.ngrok-free.app:3210', 'a b.ngrok.app']) assert.ok(!isNgrokHost(host), host);
});

function send(port: number, path: string, headers: Record<string, string>, method = 'GET', body?: string) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('server serves ngrok hosts without login but still refuses other hosts and origins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lil-deadline-ngrok-'));
  const app = new Application(new AppStorage(dir), { geminiApiKey: null });
  const root = join(dir, 'public'); mkdirSync(root); writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
  const server = createAppServer(app, { root }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const tunnel = 'demo-1.ngrok-free.app';
  try {
    assert.equal((await send(port, '/api/state', { Host: tunnel })).status, 200);
    assert.equal((await send(port, '/', { Host: tunnel })).status, 200);
    const other = await send(port, '/api/state', { Host: 'evil.example' });
    assert.equal(other.status, 403); assert.match(other.text, /Local clients only/);
    // A same-origin POST through the https tunnel is accepted; a foreign origin is not.
    const post = (origin: string) => send(port, '/api/does-not-exist', { Host: tunnel, Origin: origin, 'Content-Type': 'application/json', 'X-Lil-Deadline': '1' }, 'POST', '{}');
    assert.notEqual((await post(`https://${tunnel}`)).text.includes('Origin not permitted'), true);
    assert.match((await post('https://evil.example')).text, /Origin not permitted/);
    assert.match((await post(`http://${tunnel}`)).text, /Origin not permitted/);
  } finally {
    await app.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true });
  }
});
