/**
 * TaskStore: the app's single source of task state.
 *
 * - Mock tasks: local, editable (add / edit / complete / reset), clearly labelled Mock.
 * - Remote snapshots (Canvas LMS): read-only items; the last good snapshot is persisted so the
 *   list survives restarts and fetch failures. Items disappear from the active list when the
 *   remote service says they are submitted, excused, or marked done there.
 * - Local completion of a remote item ("checked off in TaskPet") is local-only state. It is
 *   NEVER written back to Canvas and never means coursework was submitted.
 *
 * Persisted to tasks.json (versioned) through AppStorage, separate from settings and secrets.
 */
import { randomUUID } from 'node:crypto';
import { Emitter } from '../util/emitter.ts';
import type { ProviderSnapshot, RemoteTask, TaskKind, TaskProviderId } from './types.ts';

export const TASKS_SCHEMA_VERSION = 1;

export type DoneReason = 'checked-in-taskpet' | 'submitted' | 'done-in-canvas' | 'excused';

export interface TaskView {
  /** `mock:<uuid>` or `canvas:<plannable_type>:<id>`; stable across refreshes. */
  id: string;
  provider: TaskProviderId;
  title: string;
  course: string | null;
  kind: TaskKind;
  /** ISO 8601 UTC or null. */
  dueAt: string | null;
  url: string | null;
  points: number | null;
  done: boolean;
  doneReason: DoneReason | null;
  missing: boolean;
  late: boolean;
  /** Only mock tasks can be edited/removed in the app. */
  editable: boolean;
}

export interface TaskProgress {
  total: number;
  done: number;
  remaining: number;
  overdue: number;
  /** Not done and due within the next 24 h. */
  dueSoon: number;
  /** Became done (locally or observed remotely) since local midnight. */
  completedToday: number;
}

export interface TaskStoreEvents extends Record<string, unknown> {
  changed: void;
  /** Tasks that just became done (locally or newly observed as done remotely). */
  completed: { ids: string[] };
}

export interface MockTaskInput {
  title: string;
  course?: string | null;
  dueAt?: string | null;
}

interface MockTask {
  id: string;
  title: string;
  course: string | null;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface LocalState {
  /** Checked off in TaskPet (local only). */
  completedAt: string | null;
  /** First time TaskPet observed the remote item as done. */
  remoteDoneSeenAt: string | null;
  lastSeenAt: string;
}

interface TasksFile {
  schemaVersion: typeof TASKS_SCHEMA_VERSION;
  mock: { tasks: MockTask[]; initialized: boolean };
  snapshots: Partial<Record<Exclude<TaskProviderId, 'mock'>, ProviderSnapshot>>;
  local: Record<string, LocalState>;
}

export interface TaskPersistence {
  load(): unknown;
  save(value: unknown): void;
}

/** Local state for remote items not seen for this long is pruned. */
const LOCAL_STATE_RETENTION_MS = 60 * 24 * 3600 * 1000;
const MAX_TITLE = 300;

const isObj = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

export class TaskStore extends Emitter<TaskStoreEvents> {
  private readonly persistence: TaskPersistence;
  private readonly now: () => Date;
  private data: TasksFile;

  constructor(options: { persistence: TaskPersistence; now?: () => Date }) {
    super();
    this.persistence = options.persistence;
    this.now = options.now ?? (() => new Date());
    this.data = this.normalize(this.persistence.load());
    if (!this.data.mock.initialized) {
      this.data.mock = { tasks: this.sampleMockTasks(), initialized: true };
      this.save();
    }
  }

  // --- Queries --------------------------------------------------------------------

  /** Tasks for one provider: not-done first by due date (undated last), then done. */
  list(provider: TaskProviderId): TaskView[] {
    const views = provider === 'mock' ? this.data.mock.tasks.map(t => this.mockView(t)) : this.remoteViews(provider);
    return views.sort(compareTasks);
  }

  /** Not-done tasks only (what the user still has to do). */
  active(provider: TaskProviderId): TaskView[] {
    return this.list(provider).filter(task => !task.done);
  }

  snapshotInfo(provider: Exclude<TaskProviderId, 'mock'>): { fetchedAt: string; count: number } | null {
    const snapshot = this.data.snapshots[provider];
    return snapshot ? { fetchedAt: snapshot.fetchedAt, count: snapshot.tasks.length } : null;
  }

  progress(provider: TaskProviderId): TaskProgress {
    const now = this.now();
    const nowMs = now.getTime();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const tasks = this.list(provider);
    let done = 0, overdue = 0, dueSoon = 0, completedToday = 0;
    for (const task of tasks) {
      const due = task.dueAt ? Date.parse(task.dueAt) : null;
      if (task.done) {
        done += 1;
        const at = this.doneAt(task);
        if (at !== null && at >= midnight) completedToday += 1;
      } else if (due !== null && due < nowMs) {
        overdue += 1;
      } else if (due !== null && due - nowMs <= 24 * 3600 * 1000) {
        dueSoon += 1;
      }
    }
    return { total: tasks.length, done, remaining: tasks.length - done, overdue, dueSoon, completedToday };
  }

  // --- Local completion (any provider; never written to a remote service) ----------

  /** Check/uncheck a task in TaskPet. For Canvas items this is local only, not a submission. */
  setCompleted(id: string, completed: boolean): void {
    const at = completed ? this.now().toISOString() : null;
    const mock = this.data.mock.tasks.find(task => task.id === id);
    if (mock) {
      const wasDone = mock.completedAt !== null;
      mock.completedAt = at;
      this.commit(completed && !wasDone ? [id] : []);
      return;
    }
    const remote = this.findRemote(id);
    if (!remote) throw new Error('Unknown task');
    const state = this.localState(id);
    const wasDone = this.remoteView(remote.provider, remote.task).done;
    state.completedAt = at;
    this.commit(completed && !wasDone ? [id] : []);
  }

  // --- Mock provider operations --------------------------------------------------

  addMock(input: MockTaskInput): TaskView {
    const task: MockTask = {
      id: `mock:${randomUUID()}`,
      ...this.validMockFields(input),
      completedAt: null,
      createdAt: this.now().toISOString(),
    };
    this.data.mock.tasks.push(task);
    this.commit([]);
    return this.mockView(task);
  }

  editMock(id: string, patch: Partial<MockTaskInput>): TaskView {
    const task = this.data.mock.tasks.find(candidate => candidate.id === id);
    if (!task) throw new Error('Only mock tasks can be edited in TaskPet');
    const fields = this.validMockFields({
      title: patch.title ?? task.title,
      course: patch.course !== undefined ? patch.course : task.course,
      dueAt: patch.dueAt !== undefined ? patch.dueAt : task.dueAt,
    });
    Object.assign(task, fields);
    this.commit([]);
    return this.mockView(task);
  }

  removeMock(id: string): void {
    const before = this.data.mock.tasks.length;
    this.data.mock.tasks = this.data.mock.tasks.filter(task => task.id !== id);
    if (this.data.mock.tasks.length === before) throw new Error('Only mock tasks can be removed in TaskPet');
    this.commit([]);
  }

  /** Replace mock tasks with the sample set. Does not touch Canvas data. */
  resetMock(): void {
    this.data.mock = { tasks: this.sampleMockTasks(), initialized: true };
    this.commit([]);
  }

  // --- Remote snapshots -----------------------------------------------------------

  /**
   * Apply a successful provider refresh. Items newly reported done remotely are emitted as
   * completions (so the pet can react) and drop out of the active list.
   */
  applySnapshot(snapshot: ProviderSnapshot): void {
    if (snapshot.provider === 'mock') throw new Error('Mock tasks are local; no snapshot to apply');
    const provider = snapshot.provider;
    const nowIso = this.now().toISOString();
    const previous = new Map(this.remoteViews(provider).map(view => [view.id, view.done]));
    this.data.snapshots[provider] = structuredClone(snapshot);
    const newlyDone: string[] = [];
    for (const task of snapshot.tasks) {
      const id = remoteId(provider, task.key);
      const state = this.localState(id);
      state.lastSeenAt = nowIso;
      const remoteDone = remoteDoneReason(task) !== null;
      if (remoteDone && state.remoteDoneSeenAt === null) state.remoteDoneSeenAt = nowIso;
      if (!remoteDone) state.remoteDoneSeenAt = null;
      // A first snapshot establishes a baseline: don't celebrate history.
      if (previous.has(id) && previous.get(id) === false && this.remoteView(provider, task).done) newlyDone.push(id);
    }
    this.pruneLocalState();
    this.commit(newlyDone);
  }

  // --- Internals ------------------------------------------------------------------

  private remoteViews(provider: Exclude<TaskProviderId, 'mock'>): TaskView[] {
    return (this.data.snapshots[provider]?.tasks ?? []).map(task => this.remoteView(provider, task));
  }

  private remoteView(provider: TaskProviderId, task: RemoteTask): TaskView {
    const id = remoteId(provider, task.key);
    const remoteReason = remoteDoneReason(task);
    const localDone = this.data.local[id]?.completedAt != null;
    const doneReason: DoneReason | null = remoteReason ?? (localDone ? 'checked-in-taskpet' : null);
    return {
      id, provider, title: task.title, course: task.course?.name ?? null, kind: task.kind,
      dueAt: task.dueAt, url: task.url, points: task.points,
      done: doneReason !== null, doneReason,
      missing: task.status.missing && doneReason === null,
      late: task.status.late,
      editable: false,
    };
  }

  private mockView(task: MockTask): TaskView {
    const done = task.completedAt !== null;
    return {
      id: task.id, provider: 'mock', title: task.title, course: task.course, kind: 'other',
      dueAt: task.dueAt, url: null, points: null,
      done, doneReason: done ? 'checked-in-taskpet' : null,
      missing: false, late: false, editable: true,
    };
  }

  private doneAt(task: TaskView): number | null {
    const iso = task.provider === 'mock'
      ? this.data.mock.tasks.find(t => t.id === task.id)?.completedAt
      : task.doneReason === 'checked-in-taskpet'
        ? this.data.local[task.id]?.completedAt
        : this.data.local[task.id]?.remoteDoneSeenAt;
    return iso ? Date.parse(iso) : null;
  }

  private findRemote(id: string): { provider: Exclude<TaskProviderId, 'mock'>; task: RemoteTask } | null {
    for (const provider of Object.keys(this.data.snapshots) as Array<Exclude<TaskProviderId, 'mock'>>) {
      const task = this.data.snapshots[provider]?.tasks.find(t => remoteId(provider, t.key) === id);
      if (task) return { provider, task };
    }
    return null;
  }

  private localState(id: string): LocalState {
    let state = this.data.local[id];
    if (!state) {
      state = { completedAt: null, remoteDoneSeenAt: null, lastSeenAt: this.now().toISOString() };
      this.data.local[id] = state;
    }
    return state;
  }

  private pruneLocalState(): void {
    const cutoff = this.now().getTime() - LOCAL_STATE_RETENTION_MS;
    for (const [id, state] of Object.entries(this.data.local)) {
      if (Date.parse(state.lastSeenAt) < cutoff) delete this.data.local[id];
    }
  }

  private validMockFields(input: MockTaskInput): Pick<MockTask, 'title' | 'course' | 'dueAt'> {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw new Error('A task needs a title');
    if (title.length > MAX_TITLE) throw new Error(`Titles are limited to ${MAX_TITLE} characters`);
    const course = typeof input.course === 'string' && input.course.trim() ? input.course.trim().slice(0, 120) : null;
    let dueAt: string | null = null;
    if (input.dueAt != null && input.dueAt !== '') {
      dueAt = isoOrNull(input.dueAt);
      if (dueAt === null) throw new Error('Due date is not a valid date/time');
    }
    return { title, course, dueAt };
  }

  private sampleMockTasks(): MockTask[] {
    const now = this.now();
    const at = (days: number, hour: number) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0, 0);
      return d.toISOString();
    };
    const created = now.toISOString();
    const make = (title: string, course: string | null, dueAt: string | null): MockTask =>
      ({ id: `mock:${randomUUID()}`, title, course, dueAt, completedAt: null, createdAt: created });
    return [
      make('Lab report draft', 'Sample course 101', at(-1, 23)),
      make('Read chapter 3', 'Sample course 101', at(1, 9)),
      make('Problem set 2', 'Sample course 202', at(3, 17)),
      make('Email study group', null, null),
    ];
  }

  private normalize(raw: unknown): TasksFile {
    const file: TasksFile = { schemaVersion: TASKS_SCHEMA_VERSION, mock: { tasks: [], initialized: false }, snapshots: {}, local: {} };
    if (!isObj(raw)) return file;
    if (isObj(raw.mock) && Array.isArray(raw.mock.tasks)) {
      for (const t of raw.mock.tasks) {
        if (!isObj(t) || typeof t.id !== 'string' || !t.id.startsWith('mock:') || typeof t.title !== 'string' || !t.title.trim()) continue;
        file.mock.tasks.push({
          id: t.id, title: t.title.slice(0, MAX_TITLE),
          course: typeof t.course === 'string' ? t.course.slice(0, 120) : null,
          dueAt: isoOrNull(t.dueAt), completedAt: isoOrNull(t.completedAt),
          createdAt: isoOrNull(t.createdAt) ?? new Date(0).toISOString(),
        });
      }
      file.mock.initialized = raw.mock.initialized === true;
    }
    if (isObj(raw.snapshots) && isObj(raw.snapshots.canvas)) {
      const snapshot = normalizeSnapshot(raw.snapshots.canvas, 'canvas');
      if (snapshot) file.snapshots.canvas = snapshot;
    }
    if (isObj(raw.local)) {
      for (const [id, value] of Object.entries(raw.local)) {
        if (!isObj(value)) continue;
        file.local[id] = {
          completedAt: isoOrNull(value.completedAt),
          remoteDoneSeenAt: isoOrNull(value.remoteDoneSeenAt),
          lastSeenAt: isoOrNull(value.lastSeenAt) ?? this.now().toISOString(),
        };
      }
    }
    return file;
  }

  private commit(newlyDone: string[]): void {
    this.save();
    this.emit('changed', undefined);
    if (newlyDone.length) this.emit('completed', { ids: newlyDone });
  }

  private save(): void {
    this.persistence.save(this.data);
  }
}

function remoteId(provider: TaskProviderId, key: string): string {
  return `${provider}:${key}`;
}

function remoteDoneReason(task: RemoteTask): DoneReason | null {
  if (task.status.markedDone) return 'done-in-canvas';
  if (task.status.submitted) return 'submitted';
  if (task.status.excused) return 'excused';
  return null;
}

function compareTasks(a: TaskView, b: TaskView): number {
  if (a.done !== b.done) return a.done ? 1 : -1;
  const ad = a.dueAt ? Date.parse(a.dueAt) : Infinity;
  const bd = b.dueAt ? Date.parse(b.dueAt) : Infinity;
  if (ad !== bd) return ad - bd;
  return a.title.localeCompare(b.title);
}

const KINDS: readonly TaskKind[] = ['assignment', 'quiz', 'discussion', 'event', 'note', 'page', 'other'];

/** Validate a persisted snapshot; invalid tasks are dropped. */
function normalizeSnapshot(raw: Record<string, unknown>, provider: 'canvas'): ProviderSnapshot | null {
  const fetchedAt = isoOrNull(raw.fetchedAt);
  if (!fetchedAt || !Array.isArray(raw.tasks)) return null;
  const tasks: RemoteTask[] = [];
  for (const t of raw.tasks) {
    if (!isObj(t) || typeof t.key !== 'string' || typeof t.title !== 'string') continue;
    const status = isObj(t.status) ? t.status : {};
    const course = isObj(t.course) && typeof t.course.id === 'string'
      ? { id: t.course.id, name: typeof t.course.name === 'string' ? t.course.name : null } : null;
    tasks.push({
      key: t.key, title: t.title.slice(0, MAX_TITLE),
      kind: KINDS.includes(t.kind as TaskKind) ? (t.kind as TaskKind) : 'other',
      course, dueAt: isoOrNull(t.dueAt),
      url: typeof t.url === 'string' ? t.url : null,
      points: typeof t.points === 'number' && Number.isFinite(t.points) ? t.points : null,
      status: {
        submitted: status.submitted === true, markedDone: status.markedDone === true,
        missing: status.missing === true, late: status.late === true,
        graded: status.graded === true, excused: status.excused === true,
      },
    });
  }
  return { provider, fetchedAt, tasks };
}
