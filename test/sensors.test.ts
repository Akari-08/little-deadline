import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSensorMessage } from '../src/sensors/validate.ts';
import { SensorTracker } from '../src/sensors/tracker.ts';
import type { SensorMessage } from '../src/sensors/types.ts';
import { FakeScheduler } from './helpers/fakes.ts';

/** The example message from AGENTS.md / PROTOCOL.txt. */
const example = () => ({
  type: 'sensors', seq: 42, uptime_ms: 12345,
  imu: { present: true, valid: true, sample_ms: 12340, accel_m_s2: [0.1, -0.2, 9.8], gyro_rad_s: [0.0, 0.01, 0.0], temperature_c: 28.0, roll_deg: -1.17, pitch_deg: -0.58 },
  environment: { kind: 'BME280', valid: true, sample_ms: 12000, temperature_c: 23.5, pressure_hpa: 954.2, humidity_pct: 44.1 },
  button: { enabled: false, pressed: false, press_count: 0 },
  display: { frames: 12, last_frame_id: 12 },
  rssi_dbm: -50,
} as Record<string, any>);

function parse(raw: unknown): SensorMessage {
  const result = parseSensorMessage(raw);
  assert.ok(result.ok);
  return result.message;
}

test('parses the protocol example with units preserved', () => {
  const m = parse(example());
  assert.deepEqual(m.imu.accel, [0.1, -0.2, 9.8]);
  assert.deepEqual(m.imu.gyro, [0, 0.01, 0]);
  assert.equal(m.imu.valid, true);
  assert.equal(m.imu.chipTemperatureC, 28);
  assert.equal(m.environment.humidityPct, 44.1);
  assert.equal(m.environment.pressureHpa, 954.2);
  assert.equal(m.rssiDbm, -50);
  assert.equal(m.display.lastFrameId, 12);
});

test('invalid sensors become null, never zero-filled', () => {
  const raw = example();
  raw.imu = { present: true, valid: false, sample_ms: null, accel_m_s2: [null, null, null], gyro_rad_s: [null, null, null], temperature_c: null, roll_deg: null, pitch_deg: null };
  raw.environment = { kind: 'none', valid: false, sample_ms: null, temperature_c: null, pressure_hpa: null, humidity_pct: null };
  const m = parse(raw);
  assert.equal(m.imu.present, true);
  assert.equal(m.imu.valid, false);
  assert.equal(m.imu.accel, null);
  assert.equal(m.imu.rollDeg, null);
  assert.equal(m.environment.valid, false);
  assert.equal(m.environment.temperatureC, null);
});

test('valid flag false wins even if numbers are present', () => {
  const raw = example();
  raw.imu.valid = false;
  const m = parse(raw);
  assert.equal(m.imu.accel, null);
  assert.equal(m.imu.valid, false);
});

test('BMP280 humidity is always unavailable', () => {
  const raw = example();
  raw.environment = { kind: 'BMP280', valid: true, sample_ms: 12000, temperature_c: 23.5, pressure_hpa: 954.2, humidity_pct: 50 };
  const m = parse(raw);
  assert.equal(m.environment.valid, true);
  assert.equal(m.environment.humidityPct, null);
});

test('out-of-range and wrongly-typed values are rejected individually', () => {
  const raw = example();
  raw.imu.accel_m_s2 = [0, 0, 500];
  raw.environment.pressure_hpa = 5000;
  raw.rssi_dbm = 0;
  raw.seq = -1;
  const result = parseSensorMessage(raw);
  assert.ok(result.ok);
  assert.equal(result.message.imu.accel, null);
  assert.equal(result.message.imu.valid, false, 'core IMU field missing makes the reading invalid');
  assert.equal(result.message.environment.pressureHpa, null);
  assert.equal(result.message.environment.valid, false);
  assert.equal(result.message.rssiDbm, null);
  assert.equal(result.message.seq, null);
  assert.ok(result.issues.length >= 4);
});

test('garbage input is rejected or degrades to unavailable', () => {
  assert.equal(parseSensorMessage(null).ok, false);
  assert.equal(parseSensorMessage({ type: 'frame_ack' }).ok, false);
  const m = parse({ type: 'sensors' });
  assert.equal(m.imu.valid, false);
  assert.equal(m.environment.kind, 'none');
  assert.equal(m.uptimeMs, null);
});

function trackerWith() {
  const scheduler = new FakeScheduler();
  const tracker = new SensorTracker({ scheduler });
  return { scheduler, tracker };
}

test('device ages use uint32 modular arithmetic across uptime wrap', () => {
  const { tracker } = trackerWith();
  tracker.sessionStarted();
  const raw = example();
  raw.uptime_ms = 5;          // wrapped
  raw.imu.sample_ms = 0xfffffff0; // sampled just before the wrap
  raw.environment.sample_ms = 0xffffff00;
  tracker.ingest(parse(raw));
  const snap = tracker.snapshot();
  assert.equal(snap.imu.deviceAgeMs, 21);
  assert.equal(snap.environment.deviceAgeMs, 261);
  assert.equal(snap.imu.status, 'live');
  assert.equal(snap.rebootsDetected, 0);
});

test('repeated environment sample_ms is not counted as a new reading', () => {
  const { tracker } = trackerWith();
  tracker.sessionStarted();
  const raw = example();
  const results = [];
  for (const [uptime, sample] of [[12345, 12000], [12395, 12000], [12445, 12000], [13050, 13000], [13100, 13000]]) {
    raw.uptime_ms = uptime; raw.environment.sample_ms = sample; raw.seq += 1;
    results.push(tracker.ingest(parse(raw)).newEnvironmentSample);
  }
  assert.deepEqual(results, [false, false, false, true, false]);
  assert.equal(tracker.snapshot().environment.newSamples, 1);
});

test('button presses come from press_count deltas and are never replayed after reconnect', () => {
  const { tracker } = trackerWith();
  const raw = example();
  raw.button = { enabled: true, pressed: false, press_count: 7 };
  tracker.sessionStarted();
  assert.equal(tracker.ingest(parse(raw)).presses, 0, 'first message is a baseline, not 7 presses');
  raw.button.press_count = 9; raw.seq++; raw.uptime_ms += 50;
  assert.equal(tracker.ingest(parse(raw)).presses, 2);
  tracker.sessionEnded();
  tracker.sessionStarted();
  raw.button.press_count = 15; raw.seq++; raw.uptime_ms += 5000;
  assert.equal(tracker.ingest(parse(raw)).presses, 0, 'presses during the outage are not replayed');
  raw.button.press_count = 0xffffffff; raw.seq++; raw.uptime_ms += 50;
  assert.equal(tracker.ingest(parse(raw)).presses, 0, 'absurd jump re-baselines');
  raw.button.press_count = 0; raw.seq++; raw.uptime_ms += 50;
  assert.equal(tracker.ingest(parse(raw)).presses, 1, 'counter wraps modulo 2^32');
  assert.equal(tracker.snapshot().button.totalPresses, 3);
});

test('disabled button reports unavailable and produces no presses', () => {
  const { tracker } = trackerWith();
  tracker.sessionStarted();
  const raw = example();
  raw.button = { enabled: false, pressed: false, press_count: 3 };
  assert.equal(tracker.ingest(parse(raw)).presses, 0);
  assert.equal(tracker.snapshot().button.status, 'unavailable');
});

test('device reboot is detected and counters are re-baselined', () => {
  const { tracker } = trackerWith();
  tracker.sessionStarted();
  const raw = example();
  raw.button = { enabled: true, pressed: false, press_count: 4 };
  tracker.ingest(parse(raw));
  raw.uptime_ms = 800; raw.seq = 3; raw.display.frames = 0; raw.button.press_count = 1;
  const result = tracker.ingest(parse(raw));
  assert.equal(result.rebootDetected, true);
  assert.equal(result.presses, 0);
  assert.equal(tracker.snapshot().rebootsDetected, 1);
});

test('status: live, stale by receipt age, stale after disconnect, unavailable, BMP humidity', async () => {
  const { tracker, scheduler } = trackerWith();
  assert.equal(tracker.snapshot().imu.status, 'unavailable', 'nothing received yet');
  tracker.sessionStarted();
  const raw = example();
  tracker.ingest(parse(raw));
  assert.equal(tracker.snapshot().imu.status, 'live');
  assert.equal(tracker.snapshot().environment.humidity, 'live');
  await scheduler.advance(2000);
  assert.equal(tracker.snapshot().imu.status, 'stale', 'no telemetry for 2 s');
  tracker.ingest(parse(raw));
  tracker.sessionEnded();
  const snap = tracker.snapshot();
  assert.equal(snap.imu.status, 'stale', 'last values kept but marked stale');
  assert.equal(snap.connected, false);

  tracker.sessionStarted();
  raw.environment = { kind: 'BMP280', valid: true, sample_ms: 12000, temperature_c: 20, pressure_hpa: 1000, humidity_pct: null };
  raw.imu.valid = false;
  tracker.ingest(parse(raw));
  const bmp = tracker.snapshot();
  assert.equal(bmp.environment.status, 'live');
  assert.equal(bmp.environment.humidity, 'unavailable');
  assert.equal(bmp.imu.status, 'unavailable');
});

test('old environment sample on a live link is stale', () => {
  const { tracker } = trackerWith();
  tracker.sessionStarted();
  const raw = example();
  raw.uptime_ms = 20_000; raw.environment.sample_ms = 12_000; raw.imu.sample_ms = 19_990;
  tracker.ingest(parse(raw));
  assert.equal(tracker.snapshot().environment.status, 'stale');
  assert.equal(tracker.snapshot().imu.status, 'live');
});

test('simulated data is labelled simulated, never live', () => {
  const { tracker } = trackerWith();
  tracker.sessionStarted('simulated');
  tracker.ingest(parse(example()));
  const snap = tracker.snapshot();
  assert.equal(snap.source, 'simulated');
  assert.equal(snap.imu.status, 'simulated');
  assert.equal(snap.environment.status, 'simulated');
});

test('switching peer discards the previous peer data and does not invent a reboot', () => {
  const { tracker } = trackerWith();
  tracker.sessionStarted('simulated', 'ws://127.0.0.1:8181/');
  const sim = example();
  sim.uptime_ms = 9_000_000; sim.seq = 90_000; sim.display.frames = 5000;
  tracker.ingest(parse(sim));
  tracker.sessionEnded();
  tracker.sessionStarted('device', 'ws://192.168.1.123:81/');
  const before = tracker.snapshot();
  assert.equal(before.latest, null, 'simulated readings never shown as the real device');
  assert.equal(before.imu.status, 'unavailable');
  const real = example();
  real.uptime_ms = 4000; real.seq = 10; real.display.frames = 0; real.imu.sample_ms = 3990;
  assert.equal(tracker.ingest(parse(real)).rebootDetected, false);
  assert.equal(tracker.snapshot().imu.status, 'live');
});

test('same-peer reconnect keeps reboot detection across the outage', () => {
  const { tracker } = trackerWith();
  const raw = example();
  tracker.sessionStarted('device', 'ws://192.168.1.123:81/');
  tracker.ingest(parse(raw));
  tracker.sessionEnded();
  tracker.sessionStarted('device', 'ws://192.168.1.123:81/');
  raw.uptime_ms = 500; raw.seq = 2;
  assert.equal(tracker.ingest(parse(raw)).rebootDetected, true);
});
