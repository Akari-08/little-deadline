/** Optional end-to-end smoke check; synthetic JPEGs, real local Python/model. */
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { CameraProxy } from '../src/camera/proxy.ts';
import { CvMusicBridge } from '../src/cv/music-bridge.ts';
import type { SpotifyService } from '../src/spotify/service.ts';

const canvas = createCanvas(800, 600), context = canvas.getContext('2d');
context.fillStyle = '#405060'; context.fillRect(0, 0, 800, 600);
const jpeg = canvas.toBuffer('image/jpeg');
const part = Buffer.concat([Buffer.from(`\r\n--taskpetframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`), jpeg]);
let calls = 0;
const camera = new CameraProxy((async (_url, options) => {
  calls++;
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    const timer = setInterval(() => controller.enqueue(part), 200);
    options!.signal!.addEventListener('abort', () => { clearInterval(timer); controller.error(new Error('Stopped')); }, { once: true });
  } }), { headers: { 'Content-Type': 'multipart/x-mixed-replace; boundary=taskpetframe' } });
}) as typeof fetch);
const bridge = new CvMusicBridge({ status: () => ({ connected: false }) } as unknown as SpotifyService,
  () => assert.fail('No hand in synthetic frame'), () => assert.fail('No hand in synthetic frame'), camera);
try {
  bridge.start('ws://192.168.1.123:81/', 'synthetic-smoke-check-token');
  const until = performance.now() + 55_000;
  while (bridge.status().framesProcessed < 5 && bridge.status().phase !== 'error' && performance.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const status = bridge.status();
  assert.equal(status.phase, 'live', status.message);
  assert.ok(status.framesProcessed >= 5);
  assert.equal(status.width, 800); assert.equal(status.height, 600); assert.equal(calls, 1);
  console.log('PASS: shared MJPEG parser → host stdin packets → real Python hand model → matched frame acknowledgements (800×600). No hardware used.');
} finally { bridge.stop(); camera.stop(); }
