import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCompanion, normalizeCompanion, mood, timerAction, remainingTime, settleTimer, celebrate } from '../src/pet/state.ts';
import { createCanvas } from '@napi-rs/canvas';
import { renderFace, quantizeSurface, FACE_WIDTH, FACE_HEIGHT } from '../src/render/face.ts';
import { rgbaToRGB565LE } from '../src/device/link.ts';

test('focus timer pauses, resumes, persists, completes once and resets', () => {
  const s = defaultCompanion(1000);
  timerAction(s, 'start', 1000);
  timerAction(s, 'start', 2000);
  assert.equal(remainingTime(s, 2000), 1499000, 'repeated start does not reset time');
  timerAction(s, 'pause', 2000);
  assert.equal(remainingTime(s, 5000), 1499000);
  timerAction(s, 'start', 6000);
  const restored = normalizeCompanion(JSON.parse(JSON.stringify(s)), 10_000);
  assert.equal(remainingTime(restored, 10_000), 1495000);
  assert.equal(settleTimer(restored, 1_600_000), true);
  assert.equal(settleTimer(restored, 1_600_000), false);
  assert.equal(restored.timer.sessions, 1);
  assert.equal(restored.pet.xp, 25);
  timerAction(restored, 'reset', 1_600_001);
  assert.equal(restored.timer.startedAt, null);
  assert.equal(remainingTime(restored, 1_600_001), 1500000);
});

test('corrupt companion values fall back safely; mood follows time and task rewards', () => {
  assert.equal(normalizeCompanion({ timer: {} }, 10_000).timer.startedAt, null, 'missing timer state must not start a focus session');
  const s = normalizeCompanion({ pet: { xp: -10 }, timer: { durationMs: -1, remainingMs: 'oops', startedAt: null }, provider: 'invented' }, 10_000);
  assert.equal(s.pet.xp, 0); assert.equal(s.provider, 'mock'); assert.equal(s.timer.remainingMs, 1500000);
  assert.equal(mood(s, 40_000), 'idle'); assert.equal(mood(s, 400_000), 'sleepy');
  celebrate(s, 400_000); assert.equal(mood(s, 400_001), 'celebrating'); assert.equal(s.pet.xp, 10);
  assert.equal(mood(s, 410_000), 'happy');
  timerAction(s, 'start', 420_000); assert.equal(mood(s, 420_001), 'focused');
});

test('canonical face is deterministic, opaque, 240×320 and RGB565-idempotent', () => {
  const canvas = createCanvas(FACE_WIDTH, FACE_HEIGHT);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  const s = { companion: defaultCompanion(1000), task: 'A deliberately long title that stays within the screen', done: 2, total: 4, status: 'PREVIEW MODE' };
  const pixels = () => Buffer.from(ctx.getImageData(0, 0, 240, 320).data);
  renderFace(ctx, s, 40000); const first = pixels();
  renderFace(ctx, s, 40000); assert.ok(pixels().equals(first), 'same state and time produces identical pixels');
  assert.equal(canvas.width, 240); assert.equal(canvas.height, 320);
  assert.ok(first.every((value, i) => i % 4 !== 3 || value === 255));
  const packed = rgbaToRGB565LE(first); assert.equal(packed.length, 153600);
  quantizeSurface(ctx); assert.ok(Buffer.from(rgbaToRGB565LE(pixels())).equals(Buffer.from(packed)), 'quantized preview has exactly the device color bits');
  renderFace(ctx, s, 41000); assert.ok(!pixels().equals(first), 'animation changes with explicit time');
  s.companion.pet.celebrateUntil = 50000; renderFace(ctx, s, 41000); assert.ok(!pixels().equals(first));
});
