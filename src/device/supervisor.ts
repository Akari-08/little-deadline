/**
 * DeviceSupervisor: the single owner of the TaskPet Link device connection.
 *
 * - At most one connection attempt/session exists at a time; UI code never opens sockets.
 * - Reconnects with bounded exponential backoff and jitter after transport/protocol failures.
 * - Stops automatic retries for auth/config failures until settings change or the user retries.
 * - Respects `busy`: it never forces another app off the device. It only retries a few times,
 *   slowly, when the busy owner is probably our own just-dropped session (the firmware
 *   heartbeat clears a dead owner within roughly 16-26 s).
 * - Treats a connection with no telemetry/ACK traffic as stalled and recycles it.
 * - Frames are never queued here; FrameStreamer sends the newest render after each (re)connect.
 */
import { Emitter } from '../util/emitter.ts';
import { realScheduler, type Scheduler } from '../util/scheduler.ts';
import { classifyLinkError, ConfigError, StalledLinkError, stopsAutomaticRetry, type LinkFailure } from './errors.ts';
import { createTaskPetLink, toFrameAck, toReadyInfo, type DeviceLink, type FrameAck, type LinkFactory, type ReadyInfo, type ReadyMessage } from './link.ts';
import { parseDeviceAddress } from './address.ts';
import { checkDeviceToken } from './token.ts';

export type ConnectionPhase =
  | 'stopped'     // user has not asked to connect (or pressed Disconnect)
  | 'connecting'  // socket opening / authenticating
  | 'ready'       // authenticated and `ready` received
  | 'retrying'    // waiting for the next automatic attempt
  | 'halted';     // automatic retries stopped; needs a settings change or manual retry

export interface ConnectionStatus {
  phase: ConnectionPhase;
  /** Normalized device URL (never contains credentials). */
  url: string | null;
  tokenConfigured: boolean;
  sessionId: number | null;
  /** Consecutive failed attempts since the last stable session. */
  failedAttempts: number;
  /** Milliseconds until the next automatic attempt, when retrying. */
  retryInMs: number | null;
  device: ReadyInfo | null;
  /** How long the current session has been ready. */
  readyForMs: number | null;
  /** Time since the last telemetry message or frame ACK on the current session. */
  lastTrafficAgeMs: number | null;
  lastFailure: (LinkFailure & { ageMs: number }) | null;
}

export interface ReadySession {
  readonly id: number;
  readonly device: ReadyInfo;
  sendFrame(rgb565: Uint8Array): Promise<FrameAck>;
}

export interface SupervisorEvents extends Record<string, unknown> {
  status: ConnectionStatus;
  /** Raw, unvalidated `sensors` JSON from the current session (validate with parseSensorMessage). */
  sensors: { sessionId: number; raw: unknown };
  sessionStarted: { sessionId: number; device: ReadyInfo };
  sessionEnded: { sessionId: number; failure: LinkFailure | null };
}

export interface SupervisorOptions {
  linkFactory?: LinkFactory;
  scheduler?: Scheduler;
  random?: () => number;
  /** Connector connect/auth and frame-ACK timeout. */
  timeoutMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** A session that stayed ready this long resets the backoff. */
  stableAfterMs?: number;
  /** No inbound traffic for this long marks the session stalled. */
  stallAfterMs?: number;
  busyRetryDelayMs?: number;
  busyMaxRetries?: number;
  /** `busy` within this long after our own session ended is likely our stale session. */
  busyOwnSessionWindowMs?: number;
}

interface Session {
  id: number;
  link: DeviceLink;
  readyAt: number | null;
  device: ReadyInfo | null;
  lastTrafficAt: number | null;
}

export class DeviceSupervisor extends Emitter<SupervisorEvents> {
  private readonly linkFactory: LinkFactory;
  private readonly scheduler: Scheduler;
  private readonly random: () => number;
  private readonly opts: Required<Omit<SupervisorOptions, 'linkFactory' | 'scheduler' | 'random'>>;

  private rawAddress: string | null = null;
  private url: string | null = null;
  private addressError: string | null = null;
  private token: string | null = null;
  private desired = false;
  private phase: ConnectionPhase = 'stopped';
  private session: Session | null = null;
  private nextSessionId = 0;
  private failedAttempts = 0;
  private busyRetries = 0;
  private lastReadyEndedAt: number | null = null;
  private lastFailure: (LinkFailure & { at: number }) | null = null;
  private retryTimer: unknown = null;
  private retryAt: number | null = null;
  private stallTimer: unknown = null;

  constructor(options: SupervisorOptions = {}) {
    super();
    this.linkFactory = options.linkFactory ?? createTaskPetLink;
    this.scheduler = options.scheduler ?? realScheduler;
    this.random = options.random ?? Math.random;
    this.opts = {
      timeoutMs: options.timeoutMs ?? 5000,
      backoffInitialMs: options.backoffInitialMs ?? 1000,
      backoffMaxMs: options.backoffMaxMs ?? 30_000,
      stableAfterMs: options.stableAfterMs ?? 10_000,
      stallAfterMs: options.stallAfterMs ?? 8000,
      busyRetryDelayMs: options.busyRetryDelayMs ?? 12_000,
      busyMaxRetries: options.busyMaxRetries ?? 3,
      busyOwnSessionWindowMs: options.busyOwnSessionWindowMs ?? 60_000,
    };
  }

  /**
   * Update the device address/token. A change clears a halted state and, if the user
   * wants to be connected, replaces the current connection with a fresh one.
   */
  configure(target: { address: string | null; token: string | null }): void {
    const address = target.address?.trim() || null;
    if (address === this.rawAddress && target.token === this.token) return;
    const parsed = address ? parseDeviceAddress(address) : null;
    this.rawAddress = address;
    this.url = parsed?.ok ? parsed.value.url : null;
    this.addressError = parsed && !parsed.ok ? parsed.error : null;
    this.token = target.token;
    if (!this.desired) return this.emitStatus();
    this.endSession(null);
    this.resetRetryState();
    this.attempt();
  }

  /** User pressed Connect / Retry: clear any halt and try immediately. */
  connect(): void {
    this.desired = true;
    if (this.session) return; // connecting or ready already: never open a second socket
    this.resetRetryState();
    this.attempt();
  }

  /** User pressed Disconnect / Stop: cancel retries and close the socket. */
  disconnect(): void {
    this.desired = false;
    this.resetRetryState();
    this.endSession(null);
    this.phase = 'stopped';
    this.emitStatus();
  }

  /** The ready session, or null. Frames may only be sent through this. */
  currentSession(): ReadySession | null {
    const session = this.session;
    if (!session || session.readyAt === null || !session.device) return null;
    return {
      id: session.id,
      device: session.device,
      sendFrame: async rgb565 => {
        const ack = toFrameAck(await session.link.sendFrame(rgb565));
        this.noteTraffic(session.id);
        return ack;
      },
    };
  }

  /** A frame send failed. The connector already closed the socket; recover. */
  reportFrameFailure(sessionId: number, error: unknown): void {
    this.fail(sessionId, error);
  }

  status(): ConnectionStatus {
    const now = this.scheduler.now();
    const session = this.session;
    return {
      phase: this.phase,
      url: this.url,
      tokenConfigured: this.token !== null,
      sessionId: session?.id ?? null,
      failedAttempts: this.failedAttempts,
      retryInMs: this.phase === 'retrying' && this.retryAt !== null ? Math.max(0, this.retryAt - now) : null,
      device: session?.device ?? null,
      readyForMs: session?.readyAt != null ? now - session.readyAt : null,
      lastTrafficAgeMs: session?.lastTrafficAt != null ? now - session.lastTrafficAt : null,
      lastFailure: this.lastFailure
        ? { kind: this.lastFailure.kind, code: this.lastFailure.code, message: this.lastFailure.message, ageMs: now - this.lastFailure.at }
        : null,
    };
  }

  dispose(): void {
    this.disconnect();
  }

  // ---------------------------------------------------------------------------

  private attempt(): void {
    this.clearRetryTimer();
    if (!this.desired || this.session) return;

    const configProblem = this.configProblem();
    if (configProblem) return this.halt({ kind: 'config', code: null, message: configProblem });

    const id = ++this.nextSessionId;
    let link: DeviceLink;
    try {
      link = this.linkFactory({
        url: this.url as string,
        token: this.token as string,
        timeoutMs: this.opts.timeoutMs,
        onSensors: raw => this.onSensors(id, raw),
        onError: error => this.fail(id, error),
        // The connector delivers `sensors` right after `ready`, before the connect() promise
        // continuation runs; marking ready here guarantees sessionStarted precedes telemetry.
        onStatus: status => { if (status.type === 'ready') this.onReady(id, status); },
      });
    } catch (error) {
      return this.halt(classifyLinkError(new ConfigError(error instanceof Error ? error.message : String(error)), this.token));
    }
    this.session = { id, link, readyAt: null, device: null, lastTrafficAt: null };
    this.phase = 'connecting';
    this.emitStatus();

    link.connect().then(
      message => this.onReady(id, message),
      error => this.fail(id, error),
    );
  }

  private onReady(id: number, message: ReadyMessage): void {
    const session = this.session;
    if (!session || session.id !== id || session.readyAt !== null) return; // stale, or already ready
    const now = this.scheduler.now();
    session.readyAt = now;
    session.lastTrafficAt = now;
    session.device = toReadyInfo(message);
    this.busyRetries = 0;
    this.phase = 'ready';
    this.scheduleStallCheck();
    this.emit('sessionStarted', { sessionId: id, device: session.device });
    this.emitStatus();
  }

  private onSensors(id: number, raw: unknown): void {
    if (this.session?.id !== id) return;
    this.noteTraffic(id);
    this.emit('sensors', { sessionId: id, raw });
  }

  private noteTraffic(id: number): void {
    if (this.session?.id === id) this.session.lastTrafficAt = this.scheduler.now();
  }

  private fail(id: number, error: unknown): void {
    const session = this.session;
    if (!session || session.id !== id) return; // stale callback from an old socket
    const failure = classifyLinkError(error, this.token);
    const now = this.scheduler.now();
    if (session.readyAt !== null && now - session.readyAt >= this.opts.stableAfterMs) this.failedAttempts = 0;
    this.endSession(failure);
    this.lastFailure = { ...failure, at: now };
    this.failedAttempts += 1;

    if (!this.desired) {
      this.phase = 'stopped';
      return this.emitStatus();
    }
    if (stopsAutomaticRetry(failure.kind)) return this.halt(failure);
    if (failure.kind === 'busy') {
      const likelyOurStaleSession = this.lastReadyEndedAt !== null &&
        now - this.lastReadyEndedAt <= this.opts.busyOwnSessionWindowMs;
      if (likelyOurStaleSession && this.busyRetries < this.opts.busyMaxRetries) {
        this.busyRetries += 1;
        return this.scheduleRetry(this.opts.busyRetryDelayMs);
      }
      return this.halt(failure);
    }
    this.scheduleRetry(this.backoffDelay());
  }

  private backoffDelay(): number {
    const exponent = Math.min(this.failedAttempts - 1, 20);
    const ceiling = Math.min(this.opts.backoffMaxMs, this.opts.backoffInitialMs * 2 ** exponent);
    return ceiling / 2 + this.random() * (ceiling / 2); // "equal jitter": never zero, never above ceiling
  }

  private scheduleRetry(delayMs: number): void {
    this.clearRetryTimer();
    this.phase = 'retrying';
    this.retryAt = this.scheduler.now() + delayMs;
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = null;
      this.attempt();
    }, delayMs);
    this.emitStatus();
  }

  private halt(failure: LinkFailure): void {
    this.clearRetryTimer();
    this.lastFailure = { ...failure, at: this.scheduler.now() };
    this.phase = 'halted';
    this.emitStatus();
  }

  private scheduleStallCheck(): void {
    this.clearStallTimer();
    const session = this.session;
    if (!session || session.lastTrafficAt === null) return;
    const silentMs = this.scheduler.now() - session.lastTrafficAt;
    if (silentMs >= this.opts.stallAfterMs) return this.fail(session.id, new StalledLinkError(silentMs));
    this.stallTimer = this.scheduler.setTimeout(() => {
      this.stallTimer = null;
      this.scheduleStallCheck();
    }, Math.min(1000, this.opts.stallAfterMs - silentMs));
  }

  private endSession(failure: LinkFailure | null): void {
    this.clearStallTimer();
    const session = this.session;
    if (!session) return;
    this.session = null;
    // The device may hold our old socket as owner until its heartbeat notices (~16-26 s).
    if (session.readyAt !== null) this.lastReadyEndedAt = this.scheduler.now();
    this.phase = this.desired ? 'retrying' : 'stopped'; // refined by the caller (retry/halt/stop)
    try {
      session.link.disconnect(); // idempotent in the connector; rejects any in-flight frame
    } catch { /* already closed */ }
    this.emit('sessionEnded', { sessionId: session.id, failure });
  }

  private configProblem(): string | null {
    if (this.addressError) return this.addressError;
    if (!this.url) return 'Set the device address first (e.g. 192.168.1.123 or taskpet-xxxxxx.local).';
    if (!this.token) return 'Set the device token first (the LINK_DEVICE_TOKEN from the firmware secrets.h).';
    return checkDeviceToken(this.token);
  }

  private resetRetryState(): void {
    this.clearRetryTimer();
    this.failedAttempts = 0;
    this.busyRetries = 0;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) this.scheduler.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = null;
  }

  private clearStallTimer(): void {
    if (this.stallTimer !== null) this.scheduler.clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private emitStatus(): void {
    this.emit('status', this.status());
  }
}
