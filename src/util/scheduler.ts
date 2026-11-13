/** Monotonic clock + timers, injectable so state machines can be tested deterministically. */
export interface Scheduler {
  /** Monotonic milliseconds (never wall-clock/UTC). */
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
