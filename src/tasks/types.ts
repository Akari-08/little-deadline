/**
 * Task model shared by all task providers (Mock, Canvas LMS, later Notion).
 *
 * Providers produce RemoteTask snapshots. The local TaskStore merges them with local-only
 * state (e.g. "checked off in TaskPet") keyed by a stable id. Local state is never written
 * back to a remote service unless an explicitly configured remote-write feature does so.
 */

export type TaskProviderId = 'mock' | 'canvas' | 'notion';

export type TaskKind = 'assignment' | 'quiz' | 'discussion' | 'event' | 'note' | 'page' | 'other';

/** Completion facts as reported by the remote service. All false when unknown. */
export interface RemoteTaskStatus {
  /** Work has been submitted in the remote service. */
  submitted: boolean;
  /** The user marked it done in the remote service (Canvas planner "done"/override). */
  markedDone: boolean;
  /** The remote service considers it missing (past due, not submitted). */
  missing: boolean;
  late: boolean;
  graded: boolean;
  excused: boolean;
}

export interface RemoteTask {
  /**
   * Stable within its provider across refreshes, e.g. `assignment:12345` for Canvas
   * (`plannable_type:plannable_id`). Used for de-duplication and local state.
   */
  key: string;
  title: string;
  kind: TaskKind;
  course: { id: string; name: string | null } | null;
  /** ISO 8601 UTC, or null when undated. */
  dueAt: string | null;
  /** Link to open the item in the remote service (opened in the user's browser). */
  url: string | null;
  /** Points possible, if known. */
  points: number | null;
  status: RemoteTaskStatus;
}

export interface ProviderSnapshot {
  provider: TaskProviderId;
  tasks: RemoteTask[];
  /** ISO 8601 UTC time the snapshot was fetched. */
  fetchedAt: string;
}

export type ProviderHealth =
  | 'unconfigured'   // not set up; UI must say so rather than imply sync
  | 'ready'          // configured, last refresh succeeded
  | 'error'          // last refresh failed; last good snapshot still shown
  | 'auth-required'; // credentials missing/expired/revoked; user must sign in again

export interface ProviderStatus {
  provider: TaskProviderId;
  /** Human label, e.g. "Mock tasks" or "Canvas LMS". */
  label: string;
  health: ProviderHealth;
  /** User-facing explanation; never contains credentials. */
  message: string | null;
  /** ISO 8601 UTC of the last successful refresh. */
  lastSuccessAt: string | null;
}

export class ProviderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAuthError';
  }
}

/** Read side of a task provider. Refresh failures throw; callers keep the last good snapshot. */
export interface TaskProvider {
  readonly id: TaskProviderId;
  status(): ProviderStatus;
  /**
   * Fetch a fresh snapshot. Throws ProviderAuthError when credentials are missing or rejected,
   * any other Error for transient failures. Must honour `signal` (timeouts/cancel).
   */
  refresh(signal?: AbortSignal): Promise<ProviderSnapshot>;
}
