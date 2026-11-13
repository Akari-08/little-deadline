import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceSupervisor, type ConnectionPhase } from '../src/device/supervisor.ts';
import { FakeLinks, FakeScheduler, TEST_TOKEN, flush } from './helpers/fakes.ts';

function setup(options: { random?: number; configured?: boolean } = {}) {
  const scheduler = new FakeScheduler();
  const links = new FakeLinks();
  const supervisor = new DeviceSupervisor({
    linkFactory: links.factory, scheduler, random: () => options.random ?? 1,
    backoffInitialMs: 1000, backoffMaxMs: 8000, stableAfterMs: 10_000, stallAfterMs: 8000,
    busyRetryDelayMs: 12_000, busyMaxRetries: 2, busyOwnSessionWindowMs: 60_000,
  });
  const phases: ConnectionPhase[] = [];
  supervisor.on('status', status => { if (phases.at(-1) !== status.phase) phases.push(status.phase); });
  if (options.configured !== false) supervisor.configure({ address: '192.168.1.123', token: TEST_TOKEN });
  return { scheduler, links, supervisor, phases };
}

async function connectReady(ctx: ReturnType<typeof setup>) {
  ctx.supervisor.connect();
  ctx.links.last.ready();
  await flush();
  assert.equal(ctx.supervisor.status().phase, 'ready');
}

test('normalizes the address and passes the token only to the link factory', () => {
  const { supervisor, links } = setup();
  supervisor.connect();
  assert.equal(links.last.options.url, 'ws://192.168.1.123:81/');
  assert.equal(links.last.options.token, TEST_TOKEN);
  assert.ok(!JSON.stringify(supervisor.status()).includes(TEST_TOKEN), 'status must never contain the token');
});

test('missing or invalid settings halt without opening a socket', () => {
  const { supervisor, links } = setup({ configured: false });
  supervisor.connect();
  assert.equal(supervisor.status().phase, 'halted');
  assert.equal(supervisor.status().lastFailure?.kind, 'config');
  supervisor.configure({ address: 'http://example', token: TEST_TOKEN });
  assert.equal(supervisor.status().phase, 'halted');
  supervisor.configure({ address: '10.0.0.5', token: 'short' });
  assert.match(supervisor.status().lastFailure?.message ?? '', /32–128/);
  assert.equal(links.links.length, 0);
});

test('connect reaches ready; repeated connect never opens a second socket', async () => {
  const ctx = setup();
  ctx.supervisor.connect();
  ctx.supervisor.connect();
  assert.equal(ctx.links.links.length, 1);
  assert.equal(ctx.supervisor.status().phase, 'connecting');
  assert.equal(ctx.supervisor.currentSession(), null, 'no frames before ready');
  ctx.links.last.ready();
  await flush();
  assert.equal(ctx.supervisor.status().phase, 'ready');
  assert.equal(ctx.supervisor.currentSession()?.device.maxStripRows, 16);
  ctx.supervisor.connect();
  assert.equal(ctx.links.links.length, 1);
});

test('transport failures retry with bounded exponential backoff and jitter', async () => {
  const ctx = setup({ random: 1 });
  ctx.supervisor.connect();
  const delays: number[] = [];
  for (let i = 0; i < 6; i++) {
    ctx.links.last.fail(new Error('Device disconnected'));
    await flush();
    const status = ctx.supervisor.status();
    assert.equal(status.phase, 'retrying');
    delays.push(status.retryInMs!);
    await ctx.scheduler.advance(status.retryInMs!);
    assert.equal(ctx.supervisor.status().phase, 'connecting');
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 8000, 8000]);
  assert.equal(ctx.links.links.length, 7);

  const jittered = setup({ random: 0 });
  jittered.supervisor.connect();
  jittered.links.last.fail(new Error('Device disconnected'));
  await flush();
  assert.equal(jittered.supervisor.status().retryInMs, 500, 'jitter keeps at least half the ceiling');
});

test('one failure reported twice (rejection + onError) schedules one retry', async () => {
  const ctx = setup();
  ctx.supervisor.connect();
  ctx.links.last.fail(new Error('Connection/authentication timed out'));
  await flush();
  assert.equal(ctx.supervisor.status().failedAttempts, 1);
  assert.equal(ctx.scheduler.pending, 1);
});

test('auth failure halts automatic retries until settings change or the user retries', async () => {
  const ctx = setup();
  ctx.supervisor.connect();
  ctx.links.last.fail(new Error('Device error: auth_failed'));
  await flush();
  assert.equal(ctx.supervisor.status().phase, 'halted');
  assert.equal(ctx.supervisor.status().lastFailure?.kind, 'auth');
  await ctx.scheduler.advance(10 * 60_000);
  assert.equal(ctx.links.links.length, 1, 'no automatic retry after auth failure');

  ctx.supervisor.configure({ address: '192.168.1.123', token: `${TEST_TOKEN}-2` });
  assert.equal(ctx.links.links.length, 2, 'changed token retries');
  ctx.links.last.fail(new Error('Device error: auth_failed'));
  await flush();
  ctx.supervisor.connect();
  assert.equal(ctx.links.links.length, 3, 'explicit retry is allowed');
});

test('incompatible device configuration halts', async () => {
  const ctx = setup();
  ctx.supervisor.connect();
  ctx.links.last.fail(new Error('Incompatible display configuration'));
  await flush();
  assert.equal(ctx.supervisor.status().phase, 'halted');
  assert.equal(ctx.supervisor.status().lastFailure?.kind, 'config');
});

test('disconnect cancels pending retries and closes the active socket', async () => {
  const ctx = setup();
  await connectReady(ctx);
  const first = ctx.links.last;
  ctx.supervisor.disconnect();
  assert.ok(first.disconnected);
  assert.equal(ctx.supervisor.status().phase, 'stopped');

  ctx.supervisor.connect();
  ctx.links.last.fail(new Error('Device disconnected'));
  await flush();
  assert.equal(ctx.supervisor.status().phase, 'retrying');
  ctx.supervisor.disconnect();
  await ctx.scheduler.advance(60_000);
  assert.equal(ctx.links.links.length, 2, 'Disconnect must cancel the scheduled retry');
  assert.equal(ctx.supervisor.status().phase, 'stopped');
});

test('late callbacks from a replaced socket are ignored', async () => {
  const ctx = setup();
  await connectReady(ctx);
  const old = ctx.links.last;
  old.fail(new Error('Device disconnected'));
  await flush();
  await ctx.scheduler.advance(ctx.supervisor.status().retryInMs!);
  ctx.links.last.ready();
  await flush();
  const sessionId = ctx.supervisor.status().sessionId;
  old.options.onError(new Error('Device disconnected'));
  old.sensors();
  assert.equal(ctx.supervisor.status().phase, 'ready');
  assert.equal(ctx.supervisor.status().sessionId, sessionId);
});

test('busy on a fresh connect halts instead of fighting the other app', async () => {
  const ctx = setup();
  ctx.supervisor.connect();
  ctx.links.last.fail(new Error('Device error: busy'));
  await flush();
  assert.equal(ctx.supervisor.status().phase, 'halted');
  assert.equal(ctx.supervisor.status().lastFailure?.kind, 'busy');
  await ctx.scheduler.advance(10 * 60_000);
  assert.equal(ctx.links.links.length, 1);
});

test('busy right after our own session dropped retries slowly a bounded number of times', async () => {
  const ctx = setup();
  await connectReady(ctx);
  ctx.links.last.fail(new Error('Device disconnected'));
  await flush();
  await ctx.scheduler.advance(ctx.supervisor.status().retryInMs!);
  for (let i = 0; i < 2; i++) {
    ctx.links.last.fail(new Error('Device error: busy'));
    await flush();
    assert.equal(ctx.supervisor.status().phase, 'retrying');
    assert.equal(ctx.supervisor.status().retryInMs, 12_000);
    await ctx.scheduler.advance(12_000);
  }
  ctx.links.last.fail(new Error('Device error: busy'));
  await flush();
  assert.equal(ctx.supervisor.status().phase, 'halted');
});

test('a connection with no telemetry or ACKs is treated as stalled and recycled', async () => {
  const ctx = setup();
  await connectReady(ctx);
  const link = ctx.links.last;
  await ctx.scheduler.advance(5000);
  link.sensors();
  await ctx.scheduler.advance(5000);
  assert.equal(ctx.supervisor.status().phase, 'ready', 'recent telemetry keeps it alive');
  await ctx.scheduler.advance(3000); // exactly 8 s of silence
  assert.equal(ctx.supervisor.status().phase, 'retrying');
  assert.equal(ctx.supervisor.status().lastFailure?.kind, 'stalled');
  assert.ok(link.disconnected, 'stalled socket is closed');
});

test('a stable session resets backoff; a flapping one does not', async () => {
  const ctx = setup();
  await connectReady(ctx);
  ctx.links.last.fail(new Error('Device disconnected'));
  await flush();
  await ctx.scheduler.advance(ctx.supervisor.status().retryInMs!);
  ctx.links.last.ready(); await flush();
  ctx.links.last.fail(new Error('Device disconnected')); // flapped immediately
  await flush();
  assert.equal(ctx.supervisor.status().failedAttempts, 2);
  await ctx.scheduler.advance(ctx.supervisor.status().retryInMs!);
  ctx.links.last.ready(); await flush();
  for (let i = 0; i < 11; i++) { ctx.links.last.sensors(); await ctx.scheduler.advance(1000); }
  ctx.links.last.fail(new Error('Device disconnected'));
  await flush();
  assert.equal(ctx.supervisor.status().failedAttempts, 1, 'stable session resets the counter');
});

test('errors shown to the user never contain the token', async () => {
  const ctx = setup();
  ctx.supervisor.connect();
  ctx.links.last.fail(new Error(`weird transport failure ${TEST_TOKEN}`));
  await flush();
  const message = ctx.supervisor.status().lastFailure?.message ?? '';
  assert.ok(!message.includes(TEST_TOKEN));
  assert.match(message, /\[device token\]/);
});

test('sessionStarted is emitted before telemetry that arrives in the same tick as ready', () => {
  const ctx = setup();
  const order: string[] = [];
  ctx.supervisor.on('sessionStarted', () => order.push('started'));
  ctx.supervisor.on('sensors', () => order.push('sensors'));
  ctx.supervisor.connect();
  ctx.links.last.ready();
  ctx.links.last.sensors(); // synchronously, before any promise continuation
  assert.deepEqual(order, ['started', 'sensors']);
  assert.equal(ctx.supervisor.status().phase, 'ready');
});

test('changing the address while ready replaces the socket without a duplicate', async () => {
  const ctx = setup();
  await connectReady(ctx);
  const old = ctx.links.last;
  ctx.supervisor.configure({ address: '192.168.1.200', token: TEST_TOKEN });
  assert.ok(old.disconnected, 'old socket closed first');
  assert.equal(ctx.links.links.length, 2);
  assert.equal(ctx.links.last.options.url, 'ws://192.168.1.200:81/');
  assert.equal(ctx.links.links.filter(link => !link.disconnected).length, 1);
});

test('busy right after our own Disconnect + Connect is treated as our stale socket, not halted', async () => {
  const ctx = setup();
  await connectReady(ctx);
  ctx.supervisor.disconnect();
  ctx.supervisor.connect();
  ctx.links.last.fail(new Error('Device error: busy'));
  await flush();
  assert.equal(ctx.supervisor.status().phase, 'retrying');
});
