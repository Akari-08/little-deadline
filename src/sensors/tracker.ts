/**
 * SensorTracker turns validated `sensors` messages into app-facing state:
 * - receipt age on the host monotonic clock, device ages as (uptime - sample) >>> 0;
 * - live / stale / unavailable / simulated status per sensor;
 * - repeated environment samples are not counted as new readings;
 * - button presses from debounced press_count deltas, re-baselined after reconnect/reboot
 *   so historical presses are never replayed;
 * - device reboot detection (uptime/seq/frame counters going backwards modulo 2^32).
 */
import { realScheduler, type Scheduler } from '../util/scheduler.ts';
import type { DataStatus, SensorMessage } from './types.ts';

export type SensorSource = 'device' | 'simulated';

export interface SensorSnapshot {
  source: SensorSource;
  /** Telemetry is arriving on an authenticated session (or the simulator is running). */
  connected: boolean;
  /** Most recent validated message, or null if none in this app run. */
  latest: SensorMessage | null;
  /** Host-monotonic time since that message arrived. */
  receiptAgeMs: number | null;
  imu: { status: DataStatus; deviceAgeMs: number | null };
  environment: { status: DataStatus; deviceAgeMs: number | null; humidity: DataStatus; newSamples: number };
  button: { status: DataStatus; totalPresses: number };
  rssi: { status: DataStatus; dbm: number | null };
  rebootsDetected: number;
  messages: number;
  lastIssues: string[];
}

export interface IngestResult {
  /** New short presses since the previous message (never replayed history). */
  presses: number;
  rebootDetected: boolean;
  newEnvironmentSample: boolean;
}

export interface TrackerOptions {
  scheduler?: Scheduler;
  /** No telemetry for this long marks everything stale. */
  telemetryStaleMs?: number;
  /** Device-relative IMU sample age that counts as stale. */
  imuStaleMs?: number;
  /** Device-relative environment sample age that counts as stale (nominal 1 Hz). */
  environmentStaleMs?: number;
}

const HALF_RANGE = 0x80000000;
/** Unsigned modular difference b - a; values >= 2^31 mean b is "behind" a. */
const forward = (a: number, b: number) => (b - a) >>> 0;
const wentBackwards = (previous: number | null, next: number | null) =>
  previous !== null && next !== null && next !== previous && forward(previous, next) >= HALF_RANGE;

export class SensorTracker {
  private readonly scheduler: Scheduler;
  private readonly telemetryStaleMs: number;
  private readonly imuStaleMs: number;
  private readonly environmentStaleMs: number;

  private source: SensorSource = 'device';
  private peer: string | null = null;
  private connected = false;
  private latest: SensorMessage | null = null;
  private receivedAt: number | null = null;
  private lastEnvSampleMs: number | null = null;
  private newEnvSamples = 0;
  private buttonBaseline: number | null = null;
  private totalPresses = 0;
  private reboots = 0;
  private messages = 0;
  private lastIssues: string[] = [];

  constructor(options: TrackerOptions = {}) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.telemetryStaleMs = options.telemetryStaleMs ?? 1500;
    this.imuStaleMs = options.imuStaleMs ?? 1000;
    this.environmentStaleMs = options.environmentStaleMs ?? 5000;
  }

  /**
   * A new authenticated session began: re-baseline counters. When the peer (device URL) or
   * source changes, the previous peer's readings are discarded so they can never be shown
   * as this peer's data, and cross-device counter differences are not mistaken for reboots.
   */
  sessionStarted(source: SensorSource = 'device', peer: string | null = null): void {
    if (source !== this.source || peer !== this.peer) {
      this.latest = null;
      this.receivedAt = null;
      this.lastIssues = [];
    }
    this.source = source;
    this.peer = peer;
    this.connected = true;
    this.buttonBaseline = null;
    this.lastEnvSampleMs = null;
  }

  /** The session ended: keep the last values for display but mark them stale. */
  sessionEnded(): void {
    this.connected = false;
    this.buttonBaseline = null;
  }

  ingest(message: SensorMessage, issues: string[] = []): IngestResult {
    const previous = this.latest;
    // Compared across sessions too: a reboot during an outage shows up on the first new message.
    const rebootDetected = previous !== null && (
      wentBackwards(previous.uptimeMs, message.uptimeMs) ||
      wentBackwards(previous.seq, message.seq) ||
      wentBackwards(previous.display.frames, message.display.frames));
    if (rebootDetected) {
      this.reboots += 1;
      this.buttonBaseline = null;
      this.lastEnvSampleMs = null;
    }

    let newEnvironmentSample = false;
    const envSample = message.environment.valid ? message.environment.sampleMs : null;
    if (envSample !== null && envSample !== this.lastEnvSampleMs) {
      // The first sample after (re)connect establishes the baseline; later changes are new readings.
      if (this.lastEnvSampleMs !== null) newEnvironmentSample = true;
      this.lastEnvSampleMs = envSample;
      if (newEnvironmentSample) this.newEnvSamples += 1;
    }

    let presses = 0;
    const count = message.button.enabled ? message.button.pressCount : null;
    if (count !== null) {
      if (this.buttonBaseline !== null) {
        const delta = forward(this.buttonBaseline, count);
        // A huge jump is a counter reset/glitch, not real presses: re-baseline silently.
        if (delta > 0 && delta < 100) presses = delta;
      }
      this.buttonBaseline = count;
      this.totalPresses += presses;
    }

    this.latest = message;
    this.receivedAt = this.scheduler.now();
    this.messages += 1;
    this.lastIssues = issues;
    return { presses, rebootDetected, newEnvironmentSample };
  }

  snapshot(): SensorSnapshot {
    const now = this.scheduler.now();
    const latest = this.latest;
    const receiptAgeMs = this.receivedAt === null ? null : now - this.receivedAt;
    const telemetryFresh = this.connected && receiptAgeMs !== null && receiptAgeMs <= this.telemetryStaleMs;
    const simulated = this.source === 'simulated';

    const deviceAge = (sampleMs: number | null) =>
      latest?.uptimeMs != null && sampleMs !== null ? forward(sampleMs, latest.uptimeMs) : null;
    const status = (usable: boolean, ageMs: number | null, staleMs: number): DataStatus => {
      if (!latest || !usable) return 'unavailable';
      if (simulated) return telemetryFresh ? 'simulated' : 'stale';
      if (!telemetryFresh) return 'stale';
      return ageMs !== null && ageMs > staleMs ? 'stale' : 'live';
    };

    const imuAge = deviceAge(latest?.imu.sampleMs ?? null);
    const envAge = deviceAge(latest?.environment.sampleMs ?? null);
    const imuStatus = status(latest?.imu.valid ?? false, imuAge, this.imuStaleMs);
    const envStatus = status(latest?.environment.valid ?? false, envAge, this.environmentStaleMs);
    const humidityStatus: DataStatus =
      latest?.environment.kind === 'BME280' && latest.environment.humidityPct !== null ? envStatus : 'unavailable';
    const buttonStatus = status(latest?.button.enabled ?? false, null, Infinity);
    const rssiDbm = latest?.rssiDbm ?? null;

    return {
      source: this.source,
      connected: this.connected,
      latest,
      receiptAgeMs,
      imu: { status: imuStatus, deviceAgeMs: imuAge },
      environment: { status: envStatus, deviceAgeMs: envAge, humidity: humidityStatus, newSamples: this.newEnvSamples },
      button: { status: buttonStatus, totalPresses: this.totalPresses },
      rssi: { status: status(rssiDbm !== null, null, Infinity), dbm: rssiDbm },
      rebootsDetected: this.reboots,
      messages: this.messages,
      lastIssues: this.lastIssues,
    };
  }
}
