import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStorage } from '../src/host/storage.ts';
import { SpotifyService } from '../src/spotify/service.ts';
import { parseGestureLine } from '../src/cv/music-bridge.ts';

const CLIENT_ID = 'a'.repeat(32);
function setup(fetchFn: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), 'lil-spotify-'));
  const storage = new AppStorage(dir);
  const service = new SpotifyService(storage, fetchFn);
  service.configure(CLIENT_ID);
  return { service, storage, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('Spotify PKCE uses an exact loopback redirect and keeps verifier and tokens on host', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return okJson({ access_token: 'access-sample', refresh_token: 'refresh-sample', expires_in: 3600 });
  }) as typeof fetch;
  const { service, storage, cleanup } = setup(fakeFetch);
  try {
    assert.throws(() => service.authorizeUrl('http://localhost:3210'), /127\.0\.0\.1/);
    const url = new URL(service.authorizeUrl('http://127.0.0.1:3210'));
    assert.equal(url.origin, 'https://accounts.spotify.com');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:3210/api/spotify/callback');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'user-read-playback-state user-modify-playback-state');
    const params = new URLSearchParams({ code: 'code-sample', state: url.searchParams.get('state')! });
    await assert.rejects(service.callback(new URLSearchParams({ code: 'wrong', state: 'wrong' }), 'http://127.0.0.1:3210'), /did not match/);
    assert.equal(calls.length, 0);
    await service.callback(params, 'http://127.0.0.1:3210');
    const body = calls[0]!.init.body as URLSearchParams;
    const challenge = createHash('sha256').update(body.get('code_verifier')!).digest('base64url');
    assert.equal(challenge, url.searchParams.get('code_challenge'));
    assert.equal(body.get('redirect_uri'), url.searchParams.get('redirect_uri'));
    assert.equal(service.status().connected, true);
    assert.ok(!JSON.stringify(service.status()).includes('access-sample'));
    assert.ok(!readFileSync(storage.settingsPath, 'utf8').includes('access-sample'));
    assert.ok(readFileSync(storage.secretsPath, 'utf8').includes('access-sample'));
    service.disconnect();
    assert.equal(storage.loadSpotifyTokens(), null);
  } finally { cleanup(); }
});

test('Spotify controls use playback endpoints, refresh tokens, and honor rate limits', async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const target = String(url); calls.push(`${init.method} ${target}`);
    if (target.endsWith('/api/token')) return okJson({ access_token: 'new-access', expires_in: 3600 });
    if (target.endsWith('/me/player')) return okJson({ is_playing: true, item: { name: 'Study song', artists: [{ name: 'Example artist' }] }, device: { name: 'Desk speaker', volume_percent: 40 } });
    if (target.endsWith('/me/player/next')) return new Response(null, { status: 204 });
    if (target.includes('/me/player/volume')) return new Response(null, { status: 204 });
    if (target.endsWith('/me/player/pause')) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request ${target}`);
  }) as typeof fetch;
  const { service, storage, cleanup } = setup(fakeFetch);
  try {
    storage.saveSpotifyTokens({ accessToken: 'old-access', refreshToken: 'refresh-sample', expiresAt: Date.now() - 1 });
    assert.equal((await service.refreshPlayback(true)).track, 'Study song');
    assert.equal(storage.loadSpotifyTokens()?.accessToken, 'new-access');
    await service.control('toggle');
    await service.control('next');
    await service.control('volume', 45);
    assert.ok(calls.some(c => c.includes('PUT https://api.spotify.com/v1/me/player/pause')));
    assert.ok(calls.some(c => c.includes('POST https://api.spotify.com/v1/me/player/next')));
    assert.ok(calls.some(c => c.includes('PUT https://api.spotify.com/v1/me/player/volume?volume_percent=45')));
    await assert.rejects(service.control('volume', 101), /between 0 and 100/);
  } finally { cleanup(); }
});

test('Spotify rejects missing devices and rate-limited playback cleanly', async () => {
  let status = 204;
  const fakeFetch = (async () => status === 204 ? new Response(null, { status: 204 }) : new Response(null, { status: 429, headers: { 'retry-after': '2' } })) as typeof fetch;
  const { service, storage, cleanup } = setup(fakeFetch);
  try {
    storage.saveSpotifyTokens({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600000 });
    assert.equal((await service.refreshPlayback(true)).playback, 'no-device');
    status = 429;
    assert.match((await service.refreshPlayback(true)).message ?? '', /rate limiting/);
    await assert.rejects(service.control('next'), /rate limiting/);
  } finally { cleanup(); }
});

test('playback exposes a local cover URL, keeps paused art, and clears it for missing tracks or disconnect', async () => {
  let status = 200;
  let item: Record<string, unknown> | null = { name: 'Study song', artists: [{ name: 'Example artist' }],
    external_urls: { spotify: 'https://open.spotify.com/track/abc123' },
    album: { images: [{ url: 'https://i.scdn.co/image/' + 'a'.repeat(40), width: 300, height: 300 }] } };
  const { service, storage, cleanup } = setup((async () => status === 204 ? new Response(null, { status: 204 }) : okJson({ item, is_playing: false })) as typeof fetch);
  try {
    storage.saveSpotifyTokens({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600000 });
    const first = await service.refreshPlayback(true);
    assert.equal(first.playback, 'paused'); assert.match(first.artworkUrl!, /^\/api\/spotify\/artwork\?id=/);
    assert.equal(first.trackUrl, 'https://open.spotify.com/track/abc123');
    assert.ok(!JSON.stringify(first).includes('i.scdn.co'));
    assert.equal((await service.refreshPlayback(true)).artworkUrl, first.artworkUrl);
    item = { name: 'Local track', external_urls: { spotify: 'javascript:alert(1)' } };
    const noArt = await service.refreshPlayback(true);
    assert.equal(noArt.artworkUrl, null); assert.equal(noArt.trackUrl, null);
    item = null; assert.equal((await service.refreshPlayback(true)).artworkUrl, null);
    status = 204; assert.equal((await service.refreshPlayback(true)).artworkUrl, null);
    service.disconnect(); assert.equal(service.status().artworkUrl, null);
  } finally { cleanup(); }
});

test('a playback response arriving after disconnect cannot restore old artwork', async () => {
  let finish!: (r: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const { service, storage, cleanup } = setup((async () => {
    started(); return new Promise<Response>(resolve => { finish = resolve; });
  }) as typeof fetch);
  try {
    storage.saveSpotifyTokens({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600000 });
    const pending = service.refreshPlayback(true); await ready;
    service.disconnect();
    finish(okJson({ item: { name: 'Old song', album: { images: [{ url: 'https://i.scdn.co/image/' + 'a'.repeat(40) }] } } }));
    const state = await pending;
    assert.equal(state.connected, false); assert.equal(state.track, null); assert.equal(state.artworkUrl, null);
  } finally { cleanup(); }
});

test('CV bridge accepts only bounded gesture events', () => {
  assert.deepEqual(parseGestureLine('{"kind":"gesture","action":"music_next"}'), { action: 'music_next', value: null });
  assert.deepEqual(parseGestureLine('{"kind":"gesture","action":"volume_change","value":-8}'), { action: 'volume_change', value: -8 });
  assert.deepEqual(parseGestureLine('{"kind":"gesture","action":"slide_next"}'), { action: 'slide_next', value: null });
  assert.equal(parseGestureLine('{"kind":"gesture","action":"volume_change","value":999}'), null);
  assert.equal(parseGestureLine('{"kind":"gesture","action":"open_browser"}'), null);
  assert.equal(parseGestureLine('x'.repeat(1025)), null);
});
