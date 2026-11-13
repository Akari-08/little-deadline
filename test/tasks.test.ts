import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, type TaskPersistence } from '../src/tasks/store.ts';
import { TaskSync } from '../src/tasks/sync.ts';
import { ProviderAuthError, type ProviderSnapshot, type ProviderStatus, type RemoteTask, type TaskProvider } from '../src/tasks/types.ts';
import { AppStorage } from '../src/host/storage.ts';
import { FakeScheduler, flush } from './helpers/fakes.ts';

class MemoryPersistence implements TaskPersistence {
  value: unknown = null;
  saves = 0;
  load(): unknown { return this.value === null ? null : structuredClone(this.value); }
  save(value: unknown): void { this.value = structuredClone(value); this.saves += 1; }
}

const NOW = new Date('2026-11-13T18:00:00Z');
function store(persistence = new MemoryPersistence(), now = () => NOW) {
  return { store: new TaskStore({ persistence, now }), persistence };
}

function remote(key: string, overrides: Partial<RemoteTask> = {}, status: Partial<RemoteTask['status']> = {}): RemoteTask {
  return {
    key, title: `Task ${key}`, kind: 'assignment', course: { id: '1', name: 'Course A' },
    dueAt: '2026-11-15T06:59:00Z', url: 'https://canvas.example.edu/courses/1/assignments/1', points: 10,
    status: { submitted: false, markedDone: false, missing: false, late: false, graded: false, excused: false, ...status },
    ...overrides,
  };
}
const snapshot = (tasks: RemoteTask[], fetchedAt = NOW.toISOString()): ProviderSnapshot => ({ provider: 'canvas', tasks, fetchedAt });

test('first run seeds clearly-labelled mock tasks; they persist', () => {
  const { store: s, persistence } = store();
  const mock = s.list('mock');
  assert.equal(mock.length, 4);
  assert.ok(mock.every(t => t.provider === 'mock' && t.editable && t.id.startsWith('mock:')));
  const again = new TaskStore({ persistence, now: () => NOW });
  assert.deepEqual(again.list('mock').map(t => t.id), mock.map(t => t.id), 'not re-seeded');
});

test('mock add / edit / complete / remove / reset', () => {
  const { store: s } = store();
  const completed: string[][] = [];
  s.on('completed', ({ ids }) => completed.push(ids));
  const added = s.addMock({ title: '  Write essay ', course: 'ENGL', dueAt: '2026-11-20T17:00:00-07:00' });
  assert.equal(added.title, 'Write essay');
  assert.equal(added.dueAt, '2026-11-21T00:00:00.000Z', 'stored as UTC');
  assert.throws(() => s.addMock({ title: '   ' }), /title/);
  assert.throws(() => s.addMock({ title: 'x', dueAt: 'not a date' }), /valid date/);
  const edited = s.editMock(added.id, { title: 'Write essay v2', dueAt: null });
  assert.equal(edited.dueAt, null);
  s.setCompleted(added.id, true);
  s.setCompleted(added.id, true); // idempotent: no second celebration
  assert.deepEqual(completed, [[added.id]]);
  assert.equal(s.list('mock').find(t => t.id === added.id)?.doneReason, 'checked-in-taskpet');
  s.removeMock(added.id);
  assert.equal(s.list('mock').some(t => t.id === added.id), false);
  s.resetMock();
  assert.equal(s.list('mock').length, 4);
});

test('Canvas items done in Canvas (submitted / marked done / excused) leave the active list', () => {
  const { store: s } = store();
  s.applySnapshot(snapshot([
    remote('assignment:1'),
    remote('assignment:2', {}, { submitted: true }),
    remote('quiz:3', { kind: 'quiz' }, { markedDone: true }),
    remote('assignment:4', {}, { excused: true }),
    remote('assignment:5', {}, { missing: true }),
  ]));
  const active = s.active('canvas').map(t => t.id);
  assert.deepEqual(active.sort(), ['canvas:assignment:1', 'canvas:assignment:5']);
  const all = s.list('canvas');
  assert.equal(all.find(t => t.id === 'canvas:assignment:2')?.doneReason, 'submitted');
  assert.equal(all.find(t => t.id === 'canvas:quiz:3')?.doneReason, 'done-in-canvas');
  assert.equal(all.find(t => t.id === 'canvas:assignment:4')?.doneReason, 'excused');
  assert.equal(all.find(t => t.id === 'canvas:assignment:5')?.missing, true);
  assert.ok(all.every(t => !t.editable), 'Canvas items are read-only in TaskPet');
});

test('checking a Canvas item in TaskPet is local only and survives refreshes', () => {
  const { store: s } = store();
  s.applySnapshot(snapshot([remote('assignment:1')]));
  s.setCompleted('canvas:assignment:1', true);
  const view = s.list('canvas')[0]!;
  assert.equal(view.done, true);
  assert.equal(view.doneReason, 'checked-in-taskpet', 'distinguished from a Canvas submission');
  s.applySnapshot(snapshot([remote('assignment:1')]));
  assert.equal(s.list('canvas')[0]!.done, true, 'local check kept across refresh');
  assert.throws(() => s.editMock('canvas:assignment:1', { title: 'x' }), /Only mock/);
  assert.throws(() => s.removeMock('canvas:assignment:1'), /Only mock/);
});

test('newly done in Canvas is celebrated once; the first snapshot is only a baseline', () => {
  const { store: s } = store();
  const completed: string[][] = [];
  s.on('completed', ({ ids }) => completed.push(ids));
  s.applySnapshot(snapshot([remote('assignment:1'), remote('assignment:2', {}, { submitted: true })]));
  assert.deepEqual(completed, [], 'already-submitted history is not celebrated');
  s.applySnapshot(snapshot([remote('assignment:1', {}, { submitted: true }), remote('assignment:2', {}, { submitted: true })]));
  assert.deepEqual(completed, [['canvas:assignment:1']]);
  s.applySnapshot(snapshot([remote('assignment:1', {}, { submitted: true })]));
  assert.equal(completed.length, 1);
});

test('progress counts overdue, due soon, done and completed today', () => {
  const { store: s } = store();
  s.applySnapshot(snapshot([
    remote('assignment:1', { dueAt: '2026-11-12T06:59:00Z' }),          // overdue
    remote('assignment:2', { dueAt: '2026-11-14T06:00:00Z' }),          // within 24 h
    remote('assignment:3', { dueAt: '2026-11-30T06:00:00Z' }),          // later
    remote('assignment:4', { dueAt: null }),                            // undated
  ]));
  s.applySnapshot(snapshot([
    remote('assignment:1', { dueAt: '2026-11-12T06:59:00Z' }),
    remote('assignment:2', { dueAt: '2026-11-14T06:00:00Z' }),
    remote('assignment:3', { dueAt: '2026-11-30T06:00:00Z' }, { submitted: true }),
    remote('assignment:4', { dueAt: null }),
  ]));
  assert.deepEqual(s.progress('canvas'), { total: 4, done: 1, remaining: 3, overdue: 1, dueSoon: 1, completedToday: 1 });
  const order = s.list('canvas').map(t => t.id);
  assert.deepEqual(order, ['canvas:assignment:1', 'canvas:assignment:2', 'canvas:assignment:4', 'canvas:assignment:3'], 'due order, undated last, done at end');
});

test('last good Canvas snapshot persists across restarts; corrupt entries are dropped', () => {
  const { store: s, persistence } = store();
  s.applySnapshot(snapshot([remote('assignment:1')], '2026-11-13T17:00:00Z'));
  (persistence.value as any).snapshots.canvas.tasks.push({ nonsense: true });
  const reloaded = new TaskStore({ persistence, now: () => NOW });
  assert.deepEqual(reloaded.snapshotInfo('canvas'), { fetchedAt: '2026-11-13T17:00:00.000Z', count: 1 });
  assert.equal(reloaded.list('canvas')[0]?.title, 'Task assignment:1');
});

test('tasks.json is written through AppStorage, separate from settings and secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskpet-tasks-'));
  try {
    const storage = new AppStorage(dir);
    const s = new TaskStore({ persistence: { load: () => storage.loadTasksFile(), save: v => storage.saveTasksFile(v) }, now: () => NOW });
    s.addMock({ title: 'Persist me' });
    const reloaded = new TaskStore({ persistence: { load: () => storage.loadTasksFile(), save: v => storage.saveTasksFile(v) } });
    assert.ok(reloaded.list('mock').some(t => t.title === 'Persist me'));
    assert.equal((storage.loadTasksFile() as any).schemaVersion, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- TaskSync ---------------------------------------------------------------------

class FakeProvider implements TaskProvider {
  readonly id = 'canvas' as const;
  health: ProviderStatus['health'] = 'ready';
  calls = 0;
  next: Array<() => Promise<ProviderSnapshot>> = [];
  pending: { resolve: (s: ProviderSnapshot) => void; reject: (e: Error) => void; signal: AbortSignal | undefined } | null = null;
  status(): ProviderStatus { return { provider: 'canvas', label: 'Canvas LMS', health: this.health, message: null, lastSuccessAt: null }; }
  refresh(signal?: AbortSignal): Promise<ProviderSnapshot> {
    this.calls += 1;
    const step = this.next.shift();
    if (step) return step();
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, signal };
      signal?.addEventListener('abort', () => reject(signal.reason as Error));
    });
  }
}

function sync() {
  const scheduler = new FakeScheduler();
  const { store: s } = store();
  const provider = new FakeProvider();
  const taskSync = new TaskSync({ provider, store: s, scheduler, random: () => 1, intervalMs: () => 15 * 60_000, timeoutMs: 30_000, retryInitialMs: 30_000 });
  return { scheduler, store: s, provider, taskSync };
}

test('sync: single-flight refresh, success applies snapshot and schedules the next one', async () => {
  const ctx = sync();
  ctx.taskSync.start();
  const second = ctx.taskSync.refreshNow();
  assert.equal(ctx.provider.calls, 1, 'overlapping refreshes share one fetch');
  ctx.provider.pending!.resolve(snapshot([remote('assignment:1')]));
  assert.equal(await second, true);
  assert.equal(ctx.store.list('canvas').length, 1);
  assert.equal(ctx.taskSync.status().nextRefreshInMs, 15 * 60_000);
  await ctx.scheduler.advance(15 * 60_000);
  assert.equal(ctx.provider.calls, 2);
  ctx.taskSync.stop();
});

test('sync: failure keeps the last good snapshot and backs off', async () => {
  const ctx = sync();
  ctx.provider.next.push(async () => snapshot([remote('assignment:1')]));
  ctx.taskSync.start();
  await flush();
  ctx.provider.next.push(async () => { throw new Error('HTTP 503'); });
  assert.equal(await ctx.taskSync.refreshNow(), false);
  assert.equal(ctx.store.list('canvas').length, 1, 'last good snapshot retained');
  assert.equal(ctx.taskSync.status().nextRefreshInMs, 30_000);
  ctx.provider.next.push(async () => { throw new Error('HTTP 503'); });
  await ctx.scheduler.advance(30_000);
  assert.equal(ctx.taskSync.status().nextRefreshInMs, 60_000, 'exponential backoff');
  ctx.taskSync.stop();
});

test('sync: a hung refresh times out instead of blocking forever', async () => {
  const ctx = sync();
  ctx.taskSync.start();
  assert.equal(ctx.taskSync.status().refreshing, true);
  await ctx.scheduler.advance(30_000);
  assert.equal(ctx.taskSync.status().refreshing, false);
  assert.ok(ctx.provider.pending?.signal?.aborted);
  ctx.taskSync.stop();
});

test('sync: auth errors pause automatic refresh until the user acts', async () => {
  const ctx = sync();
  ctx.provider.next.push(async () => { throw new ProviderAuthError('Sign in again'); });
  ctx.taskSync.start();
  await flush();
  assert.equal(ctx.taskSync.status().paused, true);
  assert.equal(ctx.taskSync.status().nextRefreshInMs, null);
  await ctx.scheduler.advance(24 * 3600_000);
  assert.equal(ctx.provider.calls, 1, 'no retries with bad credentials');
  ctx.provider.next.push(async () => snapshot([]));
  assert.equal(await ctx.taskSync.refreshNow(), true, 'explicit refresh after sign-in works');
  ctx.taskSync.stop();
});

test('sync: unconfigured provider does nothing and says so', async () => {
  const ctx = sync();
  ctx.provider.health = 'unconfigured';
  ctx.taskSync.start();
  await flush();
  assert.equal(ctx.provider.calls, 0);
  assert.equal(ctx.taskSync.status().provider.health, 'unconfigured');
  ctx.taskSync.stop();
});
