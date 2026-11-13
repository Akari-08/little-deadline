/**
 * FrameStreamer: paces the newest canonical 240x320 render to the device.
 *
 * - Exactly one frame in flight; the next send starts only after its frame_ack.
 * - No queue: each send pulls the *latest* render from the FrameSource, so slow links
 *   drop intermediate animation frames instead of replaying them.
 * - After every (re)connect the newest complete render is sent first.
 * - Measures delivered FPS, end-to-end ACK latency and device draw time.
 * - The app's simulation/render loop runs independently of this streaming rate.
 */
import { realScheduler, type Scheduler } from '../util/scheduler.ts';
import { rgbaToRGB565LE } from './link.ts';
import type { DeviceSupervisor } from './supervisor.ts';

export const DEFAULT_TARGET_FPS = 5;
export const MIN_TARGET_FPS = 0.5;
export const MAX_TARGET_FPS = 30;

/** One complete render of the canonical 240x320 surface (opaque RGBA, 307200 bytes). */
export interface RenderedFrame {
  /** Increases whenever the rendered pixels may have changed. */
  readonly seq: number;
  readonly rgba: Uint8Array | Uint8ClampedArray;
}

export interface FrameSource {
  /** The newest complete render, or null if nothing has been rendered yet. */
  latest(): RenderedFrame | null;
}

export interface StreamStats {
  enabled: boolean;
  targetFps: number;
  /** ACKed frames per second over the recent window; null until measured. */
  deliveredFps: number | null;
  /** Send start to frame_ack receipt (end-to-end, includes Wi-Fi and draw). */
  ackLatencyMs: { last: number; average: number; max: number } | null;
  /** Device-reported TFT transfer time only. */
  drawMs: { last: number; average: number } | null;
  framesAcked: number;
  framesFailed: number;
  inFlight: boolean;
  lastAckAgeMs: number | null;
  lastError: string | null;
}

interface AckSample { at: number; latencyMs: number; drawMs: number | null }

/** Delivered-FPS window. ACK times are pruned by age, so any target up to MAX_TARGET_FPS is measurable. */
const WINDOW_MS = 5000;
/** Latency/draw statistics use the most recent samples. */
const MAX_SAMPLES = 64;

export class FrameStreamer {
  private readonly supervisor: DeviceSupervisor;
  private readonly source: FrameSource;
  private readonly scheduler: Scheduler;
  private targetFps: number;
  private enabled = false;
  private loop: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  private readonly unsubscribe: () => void;

  private sessionId: number | null = null;
  private sessionStartedAt = 0;
  private lastSentSeq: number | null = null;
  private nextDueAt = 0;
  private inFlight = false;
  private samples: AckSample[] = [];
  private ackTimes: number[] = [];
  private framesAcked = 0;
  private framesFailed = 0;
  private lastAckAt: number | null = null;
  private lastError: string | null = null;

  constructor(options: { supervisor: DeviceSupervisor; source: FrameSource; scheduler?: Scheduler; targetFps?: number }) {
    this.supervisor = options.supervisor;
    this.source = options.source;
    this.scheduler = options.scheduler ?? realScheduler;
    this.targetFps = clampFps(options.targetFps ?? DEFAULT_TARGET_FPS);
    this.unsubscribe = this.supervisor.on('status', () => this.wake());
  }

  start(): void {
    this.enabled = true;
    this.loop ??= this.run().finally(() => { this.loop = null; });
  }

  /**
   * Stop streaming. Resolves once a frame already in flight settles: it is ACKed, times
   * out (connector default 5 s), or is rejected by supervisor.disconnect().
   */
  async stop(): Promise<void> {
    this.enabled = false;
    this.wake();
    await this.loop;
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    await this.stop();
  }

  setTargetFps(fps: number): void {
    this.targetFps = clampFps(fps);
    this.wake();
  }

  stats(): StreamStats {
    const now = this.scheduler.now();
    const recentAcks = this.ackTimes.filter(at => now - at <= WINDOW_MS).length;
    const windowMs = Math.min(WINDOW_MS, now - this.sessionStartedAt);
    const last = this.samples.at(-1);
    const draws = this.samples.flatMap(sample => (sample.drawMs === null ? [] : [sample.drawMs]));
    const lastDraw = last?.drawMs ?? null;
    return {
      enabled: this.enabled,
      targetFps: this.targetFps,
      deliveredFps: this.sessionId !== null && windowMs >= 1000 ? (recentAcks * 1000) / windowMs : null,
      ackLatencyMs: last
        ? { last: last.latencyMs, average: mean(this.samples.map(s => s.latencyMs)), max: Math.max(...this.samples.map(s => s.latencyMs)) }
        : null,
      drawMs: lastDraw !== null ? { last: lastDraw, average: mean(draws) } : null,
      framesAcked: this.framesAcked,
      framesFailed: this.framesFailed,
      inFlight: this.inFlight,
      lastAckAgeMs: this.lastAckAt === null ? null : now - this.lastAckAt,
      lastError: this.lastError,
    };
  }

  // ---------------------------------------------------------------------------

  private async run(): Promise<void> {
    while (this.enabled) {
      const session = this.supervisor.currentSession();
      if (!session) {
        this.sessionId = null;
        await this.sleep(null); // woken by the next supervisor status change
        continue;
      }
      const now = this.scheduler.now();
      if (session.id !== this.sessionId) {
        // New connection: forget per-session pacing and always send the newest render first.
        this.sessionId = session.id;
        this.sessionStartedAt = now;
        this.lastSentSeq = null;
        this.nextDueAt = now;
        this.samples = [];
        this.ackTimes = [];
        this.lastAckAt = null;
      }
      const interval = 1000 / this.targetFps;
      if (now < this.nextDueAt) {
        await this.sleep(Math.min(this.nextDueAt - now, interval));
        continue;
      }
      const frame = this.source.latest();
      if (!frame || frame.seq === this.lastSentSeq) {
        // Nothing new to show; check again shortly without spending bandwidth.
        this.nextDueAt = now + Math.min(interval, 50);
        continue;
      }

      let rgb565: Uint8Array;
      try {
        rgb565 = rgbaToRGB565LE(frame.rgba);
      } catch (error) {
        // A malformed render is an app bug, not a link failure: report and skip it.
        this.lastError = `Render rejected: ${error instanceof Error ? error.message : String(error)}`;
        this.lastSentSeq = frame.seq;
        continue;
      }

      this.nextDueAt = now + interval;
      this.inFlight = true;
      const sentAt = this.scheduler.now(); // latency excludes the local RGB565 conversion
      try {
        const ack = await session.sendFrame(rgb565);
        const ackAt = this.scheduler.now();
        this.lastSentSeq = frame.seq;
        this.framesAcked += 1;
        this.lastAckAt = ackAt;
        this.lastError = null;
        this.samples.push({ at: ackAt, latencyMs: ackAt - sentAt, drawMs: ack.drawMs });
        if (this.samples.length > MAX_SAMPLES) this.samples.shift();
        this.ackTimes.push(ackAt);
        while (this.ackTimes.length && ackAt - this.ackTimes[0]! > WINDOW_MS) this.ackTimes.shift();
      } catch (error) {
        // The connector has closed the uncertain socket; the supervisor reconnects.
        // (Only this streamer sends frames, so "already in flight" cannot come from a rival sender.)
        // Nothing is retried here: the next session starts from the newest render.
        this.framesFailed += 1;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.supervisor.reportFrameFailure(session.id, error);
      } finally {
        this.inFlight = false;
      }
    }
  }

  private sleep(ms: number | null): Promise<void> {
    return new Promise(resolve => {
      let handle: unknown = null;
      const done = () => {
        if (handle !== null) this.scheduler.clearTimeout(handle);
        if (this.wakeUp === done) this.wakeUp = null;
        resolve();
      };
      if (ms !== null) handle = this.scheduler.setTimeout(done, Math.max(0, ms));
      this.wakeUp = done;
    });
  }

  private wake(): void {
    this.wakeUp?.();
  }
}

function clampFps(fps: number): number {
  if (!Number.isFinite(fps)) return DEFAULT_TARGET_FPS;
  return Math.min(MAX_TARGET_FPS, Math.max(MIN_TARGET_FPS, fps));
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
