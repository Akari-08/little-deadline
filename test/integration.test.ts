/**
 * End-to-end over real loopback TCP: vendored connector + native Node WebSocket +
 * supervisor/streamer/tracker against the SIMULATED device (firmware rules, not hardware).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedDevice, type SimulatedDeviceOptions } from '../src/simulator/simulated-device.ts';
import { DeviceService } from '../src/host/device-service.ts';
import { TaskPetLink } from '../device-link/taskpet-link.mjs';
import { TestCardSource } from '../src/render/test-card.ts';
import type { FailureKind } from '../src/device/errors.ts';
import { TEST_TOKEN } from './helpers/fakes.ts';

const FAST = { backoffInitialMs: 50, backoffMaxMs: 200, stallAfterMs: 1500, busyRetryDelayMs: 100, timeoutMs: 2000 };

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function harness(options: { device?: Partial<SimulatedDeviceOptions>; token?: string; render?: boolean; supervisor?: Record<string, number> } = {}) {
  const device = new SimulatedDevice({ token: TEST_TOKEN, ...options.device });
  const url = await device.start();
  const source = new TestCardSource();
  source.render();
  const renderTimer = options.render === false ? null : setInterval(() => source.render(), 30);
  const service = new DeviceService({ source, targetFps: 20, supervisor: { ...FAST, ...options.supervisor } });
  const failures: FailureKind[] = [];
  service.supervisor.on('sessionEnded', ({ failure }) => { if (failure) failures.push(failure.kind); });
  service.configure({ address: url, token: options.token ?? TEST_TOKEN });
  return {
    device, service, source, failures,
    async close() {
      if (renderTimer) clearInterval(renderTimer);
      await service.dispose();
      await device.stop();
    },
  };
}

test('authenticates, streams ACK-paced frames and receives validated telemetry', async () => {
  const h = await harness();
  try {
    h.service.connect();
    await waitFor(() => h.service.diagnostics().stream.framesAcked >= 5, '5 acknowledged frames');
    const d = h.service.diagnostics();
    assert.equal(d.connection.phase, 'ready');
    assert.equal(d.live, true);
    assert.equal(d.connection.device?.buttonEnabled, false);
    assert.equal(d.sensors.source, 'simulated', 'loopback peer is never labelled as hardware');
    assert.equal(d.sensors.imu.status, 'simulated');
    assert.equal(d.sensors.environment.status, 'simulated');
    assert.equal(d.sensors.environment.humidity, 'simulated');
    assert.ok(d.stream.ackLatencyMs && d.stream.ackLatencyMs.last > 0);
    assert.equal(d.stream.drawMs?.last, 20);
    assert.deepEqual(h.device.stats.errorsSent, [], 'device saw no protocol errors');
    assert.ok(h.device.stats.frameStarts.every(([, y]) => y === 0), 'every frame starts at row 0');
    assert.equal(h.device.stats.authenticated, 1);
    assert.equal(h.device.displayed?.length, 153600);
    // Test card: first row is the white border (0xFFFF); row 1 at x=1 is red (00 F8).
    assert.deepEqual([...h.device.displayed!.subarray(0, 2)], [0xff, 0xff]);
    assert.deepEqual([...h.device.displayed!.subarray(482, 484)], [0x00, 0xf8]);
  } finally { await h.close(); }
});

test('wrong token halts after one attempt without retry storms', async () => {
  const h = await harness({ token: `${TEST_TOKEN}-wrong` });
  try {
    h.service.connect();
    await waitFor(() => h.service.diagnostics().connection.phase === 'halted', 'halted');
    assert.equal(h.service.diagnostics().connection.lastFailure?.kind, 'auth');
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(h.device.stats.connections, 1);
    assert.equal(h.device.stats.authFailures, 1);
    assert.equal(h.service.diagnostics().live, false);
  } finally { await h.close(); }
});

test('recovers from an abrupt drop: telemetry goes stale, then fresh frames from row 0', async () => {
  const h = await harness();
  try {
    let staleAtEnd: string | null = null;
    h.service.supervisor.on('sessionEnded', () => { staleAtEnd = h.service.diagnostics().sensors.imu.status; });
    h.service.connect();
    await waitFor(() => h.service.diagnostics().stream.framesAcked >= 3, 'first frames');
    const before = h.device.stats.framesCompleted;
    h.device.dropConnections();
    await waitFor(() => staleAtEnd !== null, 'session end observed');
    assert.equal(staleAtEnd, 'stale', 'sensor data marked stale when the link drops');
    await waitFor(() => h.device.stats.authenticated === 2 && h.device.stats.framesCompleted >= before + 3, 'reconnected and streaming');
    assert.ok(h.device.stats.frameStarts.every(([, y]) => y === 0), 'no partial frame resumed');
    assert.ok(!h.device.stats.errorsSent.includes('strip_order'));
    assert.equal(h.device.openConnections, 1, 'exactly one socket after recovery');
    assert.equal(h.service.diagnostics().sensors.imu.status, 'simulated');
  } finally { await h.close(); }
});

test('busy: another app owns the device; we halt and never disturb it', async () => {
  const h = await harness();
  const other = new TaskPetLink({ url: h.device.url, token: TEST_TOKEN });
  try {
    await other.connect();
    h.service.connect();
    await waitFor(() => h.service.diagnostics().connection.phase === 'halted', 'halted on busy');
    assert.equal(h.service.diagnostics().connection.lastFailure?.kind, 'busy');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(h.device.stats.busyRejections, 1, 'no repeated attempts');
    assert.equal(other.ready, true, 'the other app keeps its connection');
  } finally { other.disconnect(); await h.close(); }
});

test('a silent (frozen) device is detected as stalled and the link is recycled', async () => {
  const h = await harness({ render: false }); // static frame: no ACK traffic after the first
  try {
    h.service.connect();
    await waitFor(() => h.service.diagnostics().stream.framesAcked >= 1, 'first frame');
    h.device.setSilent(true);
    await waitFor(() => h.failures.includes('stalled'), 'stall detected', 4000);
    assert.equal(h.service.diagnostics().live, false);
    h.device.setSilent(false);
    await waitFor(() => h.service.diagnostics().live, 'live again');
  } finally { await h.close(); }
});

test('device reboot is detected after reconnect and the newest frame is redrawn', async () => {
  const h = await harness();
  try {
    h.service.connect();
    await waitFor(() => h.service.diagnostics().stream.framesAcked >= 3, 'streaming');
    await new Promise(resolve => setTimeout(resolve, 400));
    h.device.reboot();
    assert.equal(h.device.displayed, null);
    await waitFor(() => h.service.diagnostics().sensors.rebootsDetected === 1, 'reboot detected');
    await waitFor(() => h.device.displayed !== null, 'image redrawn after reboot');
  } finally { await h.close(); }
});

test('BMP280 and missing IMU are reported unavailable, not zero', async () => {
  const h = await harness({ device: { environmentKind: 'BMP280', imuPresent: false } });
  try {
    h.service.connect();
    await waitFor(() => h.service.diagnostics().sensors.messages >= 2, 'telemetry');
    const s = h.service.diagnostics().sensors;
    assert.equal(s.environment.status, 'simulated');
    assert.equal(s.environment.humidity, 'unavailable');
    assert.equal(s.latest?.environment.humidityPct, null);
    assert.equal(s.imu.status, 'unavailable');
    assert.equal(s.latest?.imu.accel, null);
  } finally { await h.close(); }
});

test('Disconnect stops retries and closes the only socket', async () => {
  const h = await harness();
  try {
    h.service.connect();
    await waitFor(() => h.service.diagnostics().stream.framesAcked >= 1, 'a frame on screen');
    h.service.disconnect();
    await waitFor(() => h.device.openConnections === 0, 'socket closed');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(h.device.stats.connections, 1, 'no reconnect after explicit Disconnect');
    assert.equal(h.service.diagnostics().connection.phase, 'stopped');
    assert.ok(h.device.displayed, 'last completed image retained by the device');
  } finally { await h.close(); }
});

test('silent Wi-Fi loss: dead link detected, busy while the device holds the dead socket, then recovery', async () => {
  const h = await harness({ supervisor: { busyRetryDelayMs: 400, busyMaxRetries: 6 } });
  try {
    h.service.connect();
    await waitFor(() => h.service.diagnostics().stream.framesAcked >= 3, 'streaming');
    const liveChanges: boolean[] = [];
    h.service.on('live', live => liveChanges.push(live));
    h.device.blackhole(2500); // no FIN/RST: the app must notice on its own
    await waitFor(() => h.failures.some(kind => kind === 'stalled' || kind === 'timeout'), 'dead link detected', 4000);
    assert.equal(liveChanges[0], false, 'live badge drops');
    await waitFor(() => h.failures.includes('busy'), 'device still owned by the dead socket', 3000);
    await waitFor(() => h.device.stats.authenticated === 2 && h.service.diagnostics().live, 'recovered after release', 6000);
    assert.ok(h.device.stats.frameStarts.every(([, y]) => y === 0), 'no partial frame resumed');
    assert.equal(h.device.openConnections, 1);
  } finally { await h.close(); }
});

test('a device protocol error closes the link, reconnects and sends a fresh frame from row 0', async () => {
  const h = await harness();
  try {
    h.service.connect();
    await waitFor(() => h.service.diagnostics().stream.framesAcked >= 2, 'streaming');
    const before = h.device.stats.framesCompleted;
    h.device.injectError('strip_order');
    await waitFor(() => h.failures.includes('protocol'), 'protocol failure handled');
    await waitFor(() => h.device.stats.authenticated === 2 && h.device.stats.framesCompleted > before + 1, 'streaming again');
    assert.ok(h.device.stats.frameStarts.every(([, y]) => y === 0));
    assert.equal(h.service.diagnostics().connection.lastFailure?.code, 'strip_order');
  } finally { await h.close(); }
});

test('a sensor that stops responding after boot is unavailable (present, not valid), never zero', async () => {
  const h = await harness();
  try {
    h.service.connect();
    await waitFor(() => h.service.diagnostics().sensors.messages >= 2, 'telemetry');
    h.device.setSensorFaults({ imu: true, environment: true });
    const startCount = h.service.diagnostics().sensors.messages;
    await waitFor(() => h.service.diagnostics().sensors.messages >= startCount + 2, 'more telemetry');
    const s = h.service.diagnostics().sensors;
    assert.equal(s.latest?.imu.present, true);
    assert.equal(s.latest?.imu.valid, false);
    assert.equal(s.latest?.imu.accel, null);
    assert.equal(s.imu.status, 'unavailable');
    assert.equal(s.latest?.environment.kind, 'BME280');
    assert.equal(s.latest?.environment.temperatureC, null);
    assert.equal(s.environment.status, 'unavailable');
  } finally { await h.close(); }
});

test('the simulated device refuses to listen on a non-loopback address', () => {
  assert.throws(() => new SimulatedDevice({ token: TEST_TOKEN, host: '0.0.0.0' }), /loopback/);
});
