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

test('Spotify sign-in works through an ngrok tunnel with an https redirect URI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lil-deadline-ngrok-'));
  const app = new Application(new AppStorage(dir), { geminiApiKey: null });
  const root = join(dir, 'public'); mkdirSync(root); writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
  const server = createAppServer(app, { root }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const tunnel = 'demo-1.ngrok-free.app';
  const post = (path: string, body: unknown) => send(port, path, { Host: tunnel, Origin: `https://${tunnel}`, 'Content-Type': 'application/json', 'X-Lil-Deadline': '1' }, 'POST', JSON.stringify(body));
  try {
    assert.equal((await post('/api/settings/spotify', { clientId: 'a'.repeat(32) })).status, 200);
    const authorize = await post('/api/spotify/authorize', {});
    assert.equal(authorize.status, 200, authorize.text);
    const url = new URL((JSON.parse(authorize.text) as { url: string }).url);
    assert.equal(url.searchParams.get('redirect_uri'), `https://${tunnel}/api/spotify/callback`);
    let seenOrigin = '';
    app.spotify.callback = async (_params, origin) => { seenOrigin = origin; };
    const callback = await send(port, '/api/spotify/callback?code=c&state=s', { Host: tunnel, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' });
    assert.equal(callback.status, 303);
    assert.equal(seenOrigin, `https://${tunnel}`, 'callback is matched against the same https tunnel origin');
    // The service itself refuses non-loopback http and non-ngrok https origins.
    assert.throws(() => app.spotify.authorizeUrl(`http://${tunnel}`), /127\.0\.0\.1 address or your ngrok/);
    assert.throws(() => app.spotify.authorizeUrl('https://evil.example'), /127\.0\.0\.1 address or your ngrok/);
    assert.match(app.spotify.authorizeUrl(`http://127.0.0.1:${port}`), /redirect_uri=http%3A%2F%2F127\.0\.0\.1/);
  } finally {
    await app.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true });
  }
});
