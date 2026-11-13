import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { MultipartParser } from '../src/camera/multipart.ts';
import { CameraProxy } from '../src/camera/proxy.ts';

const jpeg = Buffer.from([255, 216, 1, 2, 3, 4, 255, 217]);
const part = Buffer.concat([Buffer.from(`\r\n--taskpetframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`), jpeg]);

test('camera parser handles headers and JPEG split at every possible byte boundary', () => {
  for (let split = 1; split < part.length; split++) {
    const parser = new MultipartParser(), output = [...parser.push(part.subarray(0, split)), ...parser.push(part.subarray(split))];
    assert.deepEqual(output, [jpeg]); parser.finish();
  }
  const parser = new MultipartParser(), frames: Buffer[] = [];
  for (const byte of Buffer.concat([part, part, part])) frames.push(...parser.push(Buffer.from([byte])));
  assert.deepEqual(frames, [jpeg, jpeg, jpeg]); parser.finish();
});

test('camera parser bounds headers and frames and rejects truncated/malformed input', () => {
  assert.throws(() => [...new MultipartParser().push(Buffer.alloc(4097, 65))], /header too large/);
  assert.throws(() => [...new MultipartParser(4).push(part)], /exceeds limit/);
  const parser = new MultipartParser(); [...parser.push(part.subarray(0, -1))]; assert.throws(() => parser.finish(), /Truncated/);
  const corrupt = Buffer.from(part); corrupt[corrupt.length - 1] = 0;
  assert.throws(() => [...new MultipartParser().push(corrupt)], /JPEG/);
  assert.throws(() => [...new MultipartParser().push(Buffer.from('--other\r\nContent-Length: 8\r\n\r\n'))], /header/);
  assert.equal([...new MultipartParser().push(Buffer.concat(Array.from({ length: 2000 }, () => part)))].length, 2000);
});

async function harness(fetchFn: typeof fetch) {
  const token = randomBytes(32).toString('hex'), proxy = new CameraProxy(fetchFn);
  const server = createServer((req, res) => { void proxy.serve(req, res, 'ws://192.168.1.123:81/', token); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { token, proxy, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => { proxy.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('camera proxy attaches private auth and reports 401 and 503 without token leakage', async () => {
  for (const status of [401, 503]) {
    let authorization: string | null = null;
    const h = await harness((async (url, options) => {
      assert.equal(String(url), 'http://192.168.1.123:8080/stream'); assert.equal(options?.redirect, 'error');
      authorization = new Headers(options?.headers).get('authorization');
      return new Response('private upstream detail', { status });
    }) as typeof fetch);
    try {
      const r = await fetch(h.url); assert.equal(r.status, status);
      assert.equal(authorization, `Bearer ${h.token}`);
      assert.ok(!(await r.text()).includes(h.token)); assert.ok(!JSON.stringify(h.proxy.status()).includes(h.token));
      assert.equal(h.proxy.status().phase, 'error');
    } finally { await h.close(); }
  }
});

test('one upstream camera stream; a disconnected viewer cancels it and releases the slot', async () => {
  let upstreamSignal: AbortSignal | null = null, calls = 0;
  const h = await harness((async (_url, options) => {
    calls++; upstreamSignal = options!.signal!;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(part.subarray(0, 25)); controller.enqueue(part.subarray(25));
      options!.signal!.addEventListener('abort', () => controller.error(new Error('cancelled')), { once: true });
    } });
    return new Response(body, { headers: { 'Content-Type': 'multipart/x-mixed-replace; boundary=taskpetframe' } });
  }) as typeof fetch);
  try {
    const viewer = new AbortController(); const r = await fetch(h.url, { signal: viewer.signal });
    assert.equal(r.status, 200); const reader = r.body!.getReader(); const first = await reader.read();
    assert.ok(first.value!.length > jpeg.length); assert.equal(h.proxy.status().phase, 'live');
    const second = await fetch(h.url); assert.equal(second.status, 409); await second.text(); assert.equal(calls, 1);
    viewer.abort(); await reader.cancel().catch(() => {});
    const until = Date.now() + 1000;
    while (!(upstreamSignal as AbortSignal | null)?.aborted && Date.now() < until) await new Promise(r => setTimeout(r, 10));
    assert.equal((upstreamSignal as AbortSignal | null)?.aborted, true);
    const retry = new AbortController(), reopened = await fetch(h.url, { signal: retry.signal });
    assert.equal(reopened.status, 200); assert.equal(calls, 2); retry.abort(); await reopened.body?.cancel().catch(() => {});
  } finally { await h.close(); }
});
