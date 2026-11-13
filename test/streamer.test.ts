import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceSupervisor } from '../src/device/supervisor.ts';
import { FrameStreamer } from '../src/device/streamer.ts';
import { FakeLinks, FakeScheduler, MutableSource, TEST_TOKEN, flush, seqOf } from './helpers/fakes.ts';

/** Like DeviceService.dispose(): disconnecting rejects any in-flight frame, so the loop can exit. */
async function teardown(ctx: Awaited<ReturnType<typeof setup>>) {
  ctx.supervisor.disconnect();
  await ctx.streamer.dispose();
}

async function setup(targetFps = 5) {
  const scheduler = new FakeScheduler();
  const links = new FakeLinks();
  const supervisor = new DeviceSupervisor({ linkFactory: links.factory, scheduler, random: () => 1, stallAfterMs: 60_000 });
  supervisor.configure({ address: '192.168.1.123', token: TEST_TOKEN });
  const source = new MutableSource();
  const streamer = new FrameStreamer({ supervisor, source, scheduler, targetFps });
  streamer.start();
  supervisor.connect();
  links.last.ready();
  await flush();
  return { scheduler, links, supervisor, source, streamer };
}

test('one frame in flight: the next send waits for the ACK', async () => {
  const ctx = await setup();
  ctx.source.show(1);
  await ctx.scheduler.advance(60);
  assert.equal(ctx.links.last.frames.length, 1);
  ctx.source.show(2);
  await ctx.scheduler.advance(5000); // far beyond the 200 ms interval, but no ACK yet
  assert.equal(ctx.links.last.frames.length, 1, 'never a second frame while one is unacknowledged');
  ctx.links.last.ack();
  await ctx.scheduler.advance(1);
  assert.equal(ctx.links.last.frames.length, 2);
  await teardown(ctx);
});

test('sends the newest render, dropping intermediate animation frames', async () => {
  const ctx = await setup();
  ctx.source.show(1);
  await ctx.scheduler.advance(60);
  for (let seq = 2; seq <= 9; seq++) { ctx.source.show(seq); await ctx.scheduler.advance(30); }
  ctx.links.last.ack();
  await ctx.scheduler.advance(200);
  assert.deepEqual(ctx.links.last.frames.map(seqOf), [1, 9]);
  await teardown(ctx);
});

test('paces to the target FPS with fast ACKs and skips unchanged frames', async () => {
  const ctx = await setup(5);
  ctx.links.last.autoAck = true;
  let seq = 0;
  for (let t = 0; t < 2000; t += 10) { ctx.source.show(++seq); await ctx.scheduler.advance(10); }
  const sent = ctx.links.last.frames.length;
  assert.ok(sent >= 9 && sent <= 11, `expected ~10 frames in 2 s at 5 fps, got ${sent}`);
  await ctx.scheduler.advance(300); // the final render goes out once
  const before = ctx.links.last.frames.length;
  await ctx.scheduler.advance(2000); // render loop paused: same seq
  assert.equal(ctx.links.last.frames.length, before, 'unchanged render is not re-sent');
  const stats = ctx.streamer.stats();
  assert.equal(stats.targetFps, 5);
  assert.equal(stats.drawMs?.last, 65);
  await teardown(ctx);
});

test('after a disconnect it sends the newest render once, never the old in-flight frame', async () => {
  const ctx = await setup();
  ctx.source.show(1);
  await ctx.scheduler.advance(60);
  const first = ctx.links.last;
  assert.equal(first.frames.length, 1);
  first.fail(new Error('Device disconnected')); // in-flight frame rejected
  await flush();
  assert.equal(ctx.supervisor.status().phase, 'retrying');
  ctx.source.show(2); ctx.source.show(3);
  await ctx.scheduler.advance(ctx.supervisor.status().retryInMs!);
  ctx.links.last.ready();
  await ctx.scheduler.advance(60);
  const second = ctx.links.last;
  assert.notEqual(second, first);
  assert.deepEqual(second.frames.map(seqOf), [3]);
  assert.equal(ctx.streamer.stats().framesFailed, 1);
  await teardown(ctx);
});

test('a missing ACK surfaces as a failure and the supervisor reconnects', async () => {
  const ctx = await setup();
  ctx.source.show(1);
  await ctx.scheduler.advance(60);
  ctx.links.last.fail(new Error('Frame acknowledgement timed out'));
  await flush();
  const status = ctx.supervisor.status();
  assert.equal(status.phase, 'retrying');
  assert.equal(status.lastFailure?.kind, 'timeout');
  assert.match(ctx.streamer.stats().lastError ?? '', /timed out/);
  await teardown(ctx);
});

test('a malformed render is reported without dropping the connection', async () => {
  const ctx = await setup();
  ctx.source.frame = { seq: 1, rgba: new Uint8ClampedArray(10) };
  await ctx.scheduler.advance(60);
  assert.equal(ctx.links.last.frames.length, 0);
  assert.match(ctx.streamer.stats().lastError ?? '', /Render rejected/);
  assert.equal(ctx.supervisor.status().phase, 'ready');
  await teardown(ctx);
});

test('delivered FPS is measurable above 12.8 fps (window pruned by age, not sample count)', async () => {
  const ctx = await setup(20);
  ctx.links.last.autoAck = true;
  let seq = 0;
  for (let t = 0; t < 3000; t += 10) { ctx.source.show(++seq); await ctx.scheduler.advance(10); }
  const fps = ctx.streamer.stats().deliveredFps;
  assert.ok(fps !== null && fps > 18 && fps <= 21, `expected ~20 fps, got ${fps}`);
  await teardown(ctx);
});
