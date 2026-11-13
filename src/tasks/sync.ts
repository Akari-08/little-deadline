/**
 * TaskSync: periodically refreshes one remote TaskProvider into the TaskStore.
 *
 * - Single-flight: overlapping refresh requests share one in-flight fetch.
 * - Every refresh has a timeout; failures keep the last good snapshot (the store is only
 *   updated on success).
 * - Transient errors back off (with jitter) up to the normal interval.
 * - Auth errors stop automatic refreshes until the user signs in again / calls refreshNow().
 */
import { Emitter } from '../util/emitter.ts';
import { realScheduler, type Scheduler } from '../util/scheduler.ts';
import { ProviderAuthError, type ProviderStatus, type TaskProvider } from './types.ts';
import type { TaskStore } from './store.ts';

export interface SyncStatus {
  provider: ProviderStatus;
  refreshing: boolean;
  /** Next automatic refresh, if scheduled. */
  nextRefreshInMs: number | null;
  /** Automatic refreshes paused (auth problem or stopped). */
  paused: boolean;
  snapshot: { fetchedAt: string; count: number } | null;
}

export interface TaskSyncOptions {
  provider: TaskProvider;
  store: TaskStore;
  scheduler?: Scheduler;
  random?: () => number;
  /** Normal refresh period (read each time so settings changes apply). */
  intervalMs: () => number;
  timeoutMs?: number;
  retryInitialMs?: number;
}

export class TaskSync extends Emitter<{ status: SyncStatus }> {
  private readonly provider: TaskProvider;
  private readonly store: TaskStore;
  private readonly scheduler: Scheduler;
  private readonly random: () => number;
  private readonly intervalMs: () => number;
  private readonly timeoutMs: number;
  private readonly retryInitialMs: number;
  private running = false;
  private paused = false;
  private inFlight: Promise<boolean> | null = null;
  private timer: unknown = null;
  private nextAt: number | null = null;
  private failures = 0;
  private controller: AbortController | null = null;

  constructor(options: TaskSyncOptions) {
    super();
    this.provider = options.provider;
    this.store = options.store;
    this.scheduler = options.scheduler ?? realScheduler;
    this.random = options.random ?? Math.random;
    this.intervalMs = options.intervalMs;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryInitialMs = options.retryInitialMs ?? 30_000;
  }

  /** Start automatic refreshing (refreshes immediately when configured). */
  start(): void {
    this.running = true;
    this.paused = false;
    void this.refreshNow();
  }

  stop(): void {
    this.running = false;
    this.controller?.abort(new Error('Refresh stopped'));
    this.clearTimer();
    this.emitStatus();
  }

  /**
   * Refresh now (user "Refresh" or after sign-in). Resolves true on success. Clears an
   * auth pause. Never throws: failures are reported through status().
   */
  refreshNow(): Promise<boolean> {
    this.paused = false;
    if (this.inFlight) return this.inFlight;
    this.clearTimer();
    if (this.provider.status().health === 'unconfigured') {
      this.emitStatus();
      return Promise.resolve(false);
    }
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
      this.emitStatus();
    });
    this.emitStatus();
    return this.inFlight;
  }

  status(): SyncStatus {
    const kind = this.provider.id;
    return {
      provider: this.provider.status(),
      refreshing: this.inFlight !== null,
      nextRefreshInMs: this.nextAt === null ? null : Math.max(0, this.nextAt - this.scheduler.now()),
      paused: this.paused || !this.running,
      snapshot: kind === 'mock' ? null : this.store.snapshotInfo(kind),
    };
  }

  private async run(): Promise<boolean> {
    const controller = new AbortController();
    this.controller = controller;
    const timeout = this.scheduler.setTimeout(() => controller.abort(new Error('Refresh timed out')), this.timeoutMs);
    try {
      const snapshot = await this.provider.refresh(controller.signal);
      if (controller.signal.aborted) return false;
      this.store.applySnapshot(snapshot);
      this.failures = 0;
      this.schedule(this.intervalMs());
      return true;
    } catch (error) {
      if (error instanceof ProviderAuthError) {
        this.paused = true; // do not hammer the service with bad credentials
        return false;
      }
      this.failures += 1;
      const ceiling = Math.min(this.intervalMs(), this.retryInitialMs * 2 ** Math.min(this.failures - 1, 10));
      this.schedule(ceiling / 2 + this.random() * (ceiling / 2));
      return false;
    } finally {
      if (this.controller === controller) this.controller = null;
      this.scheduler.clearTimeout(timeout);
    }
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (!this.running || this.paused) return;
    this.nextAt = this.scheduler.now() + delayMs;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      this.nextAt = null;
      void this.refreshNow();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
  }

  private emitStatus(): void {
    this.emit('status', this.status());
  }
}
