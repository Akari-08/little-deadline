import type { Scheduler } from '../../src/util/scheduler.ts';
import type { DeviceLink, FrameAckMessage, LinkFactory, LinkOptions, ReadyMessage } from '../../src/device/link.ts';
import type { FrameSource, RenderedFrame } from '../../src/device/streamer.ts';

export const TEST_TOKEN = 'test-only-device-token-not-a-real-secret';

export const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** Deterministic monotonic clock + timers. `advance` runs due timers in time order. */
export class FakeScheduler implements Scheduler {
  time = 1000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number { return this.time; }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  get pending(): number { return this.timers.size; }

  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    await flush();
    for (;;) {
      let nextId: number | null = null, nextAt = Infinity;
      for (const [id, timer] of this.timers) if (timer.at <= end && timer.at < nextAt) { nextAt = timer.at; nextId = id; }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.time = timer.at;
      timer.fn();
      await flush();
    }
    this.time = end;
    await flush();
  }
}

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export const READY: ReadyMessage = {
  type: 'ready', protocol: 'taskpet-link/1', width: 240, height: 320, format: 'rgb565le',
  max_strip_rows: 16, telemetry_hz: 20, button_enabled: false,
};

/** Mimics the connector: failures reject pending work AND call onError; disconnect is quiet. */
export class FakeLink implements DeviceLink {
  readonly options: LinkOptions;
  readonly frames: Uint8Array[] = [];
  disconnected = false;
  private connectDeferred: Deferred<ReadyMessage> | null = null;
  private frameDeferred: { id: number; d: Deferred<FrameAckMessage> } | null = null;
  private frameId = 0;
  autoAck = false;

  constructor(options: LinkOptions) { this.options = options; }

  connect(): Promise<ReadyMessage> {
    this.connectDeferred = deferred();
    return this.connectDeferred.promise;
  }
  sendFrame(rgb565: Uint8Array): Promise<FrameAckMessage> {
    if (this.disconnected) return Promise.reject(new Error('Connect before sending frames'));
    if (this.frameDeferred) return Promise.reject(new Error('A frame is already in flight'));
    this.frames.push(rgb565);
    const id = ++this.frameId;
    const d = deferred<FrameAckMessage>();
    this.frameDeferred = { id, d };
    if (this.autoAck) queueMicrotask(() => this.ack());
    return d.promise;
  }
  disconnect(): void {
    this.disconnected = true;
    const error = new Error('Connection closed by app');
    this.connectDeferred?.reject(error);
    this.frameDeferred?.d.reject(error);
    this.connectDeferred = null;
    this.frameDeferred = null;
  }

  // --- test controls ---
  get frameInFlight(): boolean { return this.frameDeferred !== null; }
  /** Like the connector: onStatus(ready) fires synchronously, then connect() resolves. */
  ready(message: ReadyMessage = READY): void {
    this.options.onStatus(message);
    this.connectDeferred?.resolve(message);
    this.connectDeferred = null;
  }
  ack(drawMs = 65): void {
    const pending = this.frameDeferred;
    if (!pending) return;
    this.frameDeferred = null;
    pending.d.resolve({ type: 'frame_ack', frame_id: pending.id, frames: pending.id, draw_ms: drawMs, uptime_ms: 1 });
  }
  /** Connector-style failure: reject everything pending and report via onError. */
  fail(error: Error): void {
    this.connectDeferred?.reject(error);
    this.frameDeferred?.d.reject(error);
    this.connectDeferred = null;
    this.frameDeferred = null;
    this.disconnected = true;
    this.options.onError(error);
  }
  sensors(raw: unknown = { type: 'sensors' }): void { this.options.onSensors(raw); }
}

export class FakeLinks {
  readonly links: FakeLink[] = [];
  autoAck = false;
  readonly factory: LinkFactory = options => {
    const link = new FakeLink(options);
    link.autoAck = this.autoAck;
    this.links.push(link);
    return link;
  };
  get last(): FakeLink {
    const link = this.links.at(-1);
    if (!link) throw new Error('no link created');
    return link;
  }
}

/** Encode `seq` into pixel 0 so tests can tell which render reached the link. */
export function frameWithSeq(seq: number): RenderedFrame {
  const rgba = new Uint8ClampedArray(240 * 320 * 4).fill(255);
  rgba[0] = (seq & 31) << 3;
  rgba[1] = ((seq >> 5) & 63) << 2;
  return { seq, rgba };
}
export function seqOf(rgb565: Uint8Array): number {
  const value = rgb565[0]! | (rgb565[1]! << 8);
  return (value >> 11) | (((value >> 5) & 63) << 5);
}

export class MutableSource implements FrameSource {
  frame: RenderedFrame | null = null;
  show(seq: number): void { this.frame = frameWithSeq(seq); }
  latest(): RenderedFrame | null { return this.frame; }
}
