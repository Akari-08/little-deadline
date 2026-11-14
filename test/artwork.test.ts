import test from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyArtwork } from '../src/spotify/artwork.ts';
import { CanvasImageLoader } from '../web/canvas-image.ts';

const source = (digit: string) => `https://i.scdn.co/image/${digit.repeat(40)}`;
const image = (digit = 'a', width: number | null = 300) => ({ url: source(digit), width, height: width });
const id = (path: string | null) => new URL(path!, 'http://localhost').searchParams.get('id');
const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });

test('artwork selects a modest image and shares one credential-free cached download', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const artwork = new SpotifyArtwork((async (url, init) => { calls.push({ url: String(url), init: init! }); return png(); }) as typeof fetch);
  const images = [image('a', 640), image('b', 300), image('c', 64)];
  const path = artwork.select(images);
  assert.match(path!, /^\/api\/spotify\/artwork\?id=[a-f\d]{64}$/);
  const [first, second] = await Promise.all([artwork.get(id(path)), artwork.get(id(path))]);
  assert.ok(first); assert.equal(first, second); assert.equal(first.contentType, 'image/png');
  assert.equal(calls.length, 1); assert.equal(calls[0]!.url, source('b'));
  assert.equal(new Headers(calls[0]!.init.headers).has('authorization'), false);
  assert.equal(calls[0]!.init.redirect, 'error'); assert.equal(calls[0]!.init.credentials, 'omit');
  assert.ok(calls[0]!.init.signal);
  assert.equal(artwork.select(images), path);
  assert.equal(await artwork.get(id(path)), first); assert.equal(calls.length, 1);
  assert.equal(await artwork.get('https://untrusted.example/image'), null);
  artwork.clear(); assert.equal(await artwork.get(id(path)), null);
});

test('artwork rejects unsafe sources and tolerates missing image dimensions', async () => {
  const artwork = new SpotifyArtwork((async () => png()) as typeof fetch);
  for (const url of ['http://i.scdn.co/image/' + 'a'.repeat(40), 'https://127.0.0.1/image/a',
    'https://i.scdn.co.evil.example/image/' + 'a'.repeat(40), 'https://user:password@i.scdn.co/image/' + 'a'.repeat(40),
    source('a') + '?secret=bad', 'data:image/png;base64,AA==']) {
    assert.equal(artwork.select([{ url, width: 300 }]), null);
  }
  assert.ok(artwork.select([image('a', null)]));
  assert.ok(artwork.select([image('a', 64)]));
  for (const images of [null, {}, [], [null], [{ url: 42 }]]) assert.equal(artwork.select(images), null);
});

test('changing tracks aborts an old download and discards its late result', async () => {
  let finish!: (r: Response) => void;
  let signal: AbortSignal | undefined;
  const artwork = new SpotifyArtwork((async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(resolve => { finish = resolve; });
  }) as typeof fetch);
  const oldPath = artwork.select([image('a')]);
  const pending = artwork.get(id(oldPath));
  const newPath = artwork.select([image('b')]);
  assert.notEqual(newPath, oldPath); assert.equal(signal?.aborted, true);
  finish(png()); assert.equal(await pending, null);
  assert.equal(await artwork.get(id(oldPath)), null);
  artwork.clear();
});

test('failed, redirected, oversized, empty and non-image downloads fall back with a cooldown', async () => {
  const responses = [
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } }),
    () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    () => new Response('x', { headers: { 'Content-Type': 'image/png', 'Content-Length': '1048577' } }),
    () => new Response(new Uint8Array(1048577), { headers: { 'Content-Type': 'image/jpeg' } }),
    () => new Response('', { headers: { 'Content-Type': 'image/png' } }),
    () => { throw new Error('offline'); },
  ];
  for (const response of responses) {
    let calls = 0;
    const artwork = new SpotifyArtwork((async () => { calls++; return response(); }) as typeof fetch);
    const path = artwork.select([image()]);
    assert.equal(await artwork.get(id(path)), null);
    assert.equal(await artwork.get(id(path)), null); assert.equal(calls, 1);
    artwork.clear();
  }
});

function imageHarness() {
  const images: HTMLImageElement[] = [];
  let now = 100;
  const loader = new CanvasImageLoader(() => {
    const next = { src: '', naturalWidth: 300, naturalHeight: 300, onload: null, onerror: null } as unknown as HTMLImageElement;
    images.push(next); return next;
  }, () => now);
  return { loader, images, advance: () => { now += 30_001; return now; } };
}
const local = (digit: string) => '/api/spotify/artwork?id=' + digit.repeat(64);
function loaded(image: HTMLImageElement) { image.onload?.call(image, new Event('load')); }

test('canvas loading never returns the previous cover during track changes or late image callbacks', () => {
  const { loader, images } = imageHarness();
  assert.equal(loader.update(local('a'), 100), null);
  const first = images[0]!, lateLoad = first.onload;
  loaded(first); assert.equal(loader.update(local('a'), 100)?.source, first);
  assert.equal(images.length, 1);
  assert.equal(loader.update(local('b'), 100), null);
  lateLoad?.call(first, new Event('load'));
  assert.equal(loader.update(local('b'), 100), null);
  loaded(images[1]!); assert.equal(loader.update(local('b'), 100)?.source, images[1]);
  assert.equal(loader.update(null, 100), null); assert.equal(images[1]!.src, '');
  assert.equal(loader.update(source('a'), 100), null); assert.equal(images.length, 2);
  loader.dispose();
});

test('canvas loading retries failed decoding at a bounded rate and rejects invalid dimensions', () => {
  const { loader, images, advance } = imageHarness();
  loader.update(local('a'), 100);
  images[0]!.onerror?.call(images[0]!, new Event('error'));
  assert.equal(loader.update(local('a'), 101), null); assert.equal(images.length, 1);
  assert.equal(loader.update(local('a'), advance()), null); assert.equal(images.length, 2);
  Object.assign(images[1]!, { naturalWidth: 0 }); loaded(images[1]!);
  assert.equal(loader.update(local('a'), advance()), null); assert.equal(images.length, 3);
  loaded(images[2]!); assert.ok(loader.update(local('a'), 100_000));
  loader.dispose();
});
