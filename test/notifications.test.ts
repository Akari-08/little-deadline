import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { NotificationCenter } from '../src/notifications/center.ts';
import {
  applyPrefsPatch, bannerText, defaultState, evaluate, normalizeState, DEFAULT_PREFS, MAX_ITEMS,
  type NotificationInput, type NotificationItem, type NotificationKind, type NotificationState,
} from '../src/notifications/rules.ts';
import type { TaskView } from '../src/tasks/store.ts';
import type { SyncStatus } from '../src/tasks/sync.ts';
import type { ProviderHealth } from '../src/tasks/types.ts';
import { renderFace, FACE_WIDTH, FACE_HEIGHT } from '../src/render/face.ts';
import { defaultCompanion } from '../src/pet/state.ts';
import { Application } from '../src/host/application.ts';
import { AppStorage } from '../src/host/storage.ts';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const TZ = 'UTC';
/** Friday 2026-11-13 09:00 UTC — after the default 8 am digest hour, outside quiet hours. */
const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function task(id: string, over: Partial<TaskView> = {}): TaskView {
  return { id, provider: 'mock', title: id, course: null, kind: 'assignment', dueAt: null, url: null, points: null, done: false,
    doneReason: null, missing: false, late: false, editable: true, priority: 'normal', ...over };
}
function sync(provider: 'canvas' | 'notion', health: ProviderHealth = 'ready', snapshot = true, refreshing = false): SyncStatus {
  return { provider: { provider, label: provider === 'canvas' ? 'Canvas LMS' : 'Notion', health, message: health === 'ready' ? null : 'Token rejected.', lastSuccessAt: null },
    refreshing, nextRefreshInMs: null, paused: false, snapshot: snapshot ? { fetchedAt: iso(T0), count: 0 } : null };
}
function input(now: number, tasks: TaskView[], over: Partial<NotificationInput> = {}): NotificationInput {
  return { now, tasks, providers: { canvas: sync('canvas'), notion: sync('notion', 'unconfigured', false) }, focusSessions: 0, ...over };
}
/** A state with only the given kinds enabled. */
function only(...kinds: NotificationKind[]): NotificationState {
  const s = defaultState();
  for (const k of Object.keys(s.prefs.enabled) as NotificationKind[]) s.prefs.enabled[k] = kinds.includes(k);
  return s;
}
/** Run successive evaluations, returning the items added at each step. */
function runner(state: NotificationState) {
  let s = state;
  return {
    step(i: NotificationInput): NotificationItem[] { const r = evaluate(s, i, TZ); s = r.state; return r.added; },
    get state() { return s; },
  };
}

test('due-soon fires once per stage, worded relative to the local day', () => {
  const r = runner(only('due-soon'));
  const lab = task('mock:lab4', { title: 'Lab 4', course: 'CHEM 101', dueAt: iso(T0 + 30 * HOUR) });
  assert.equal(r.step(input(T0, [lab])).length, 0, 'not inside any reminder window yet');
  const first = r.step(input(T0 + 7 * HOUR, [lab]));
  assert.equal(first.length, 1);
  assert.equal(first[0]!.title, 'Due tomorrow: Lab 4');
  assert.match(first[0]!.body, /^CHEM 101 · Sat, Nov 14, 3:00 PM/);
  assert.equal(r.step(input(T0 + 7 * HOUR + MIN, [lab])).length, 0, 'same stage never repeats');
  const second = r.step(input(T0 + 28.5 * HOUR, [lab]));
  assert.equal(second.length, 1);
  assert.equal(second[0]!.title, 'Due today: Lab 4');
  assert.equal(r.step(input(T0 + 29 * HOUR, [lab])).length, 0);
});

test('a task added inside the window gets only its tightest stage', () => {
  const r = runner(only('due-soon'));
  const quiz = task('mock:quiz', { title: 'Quiz', dueAt: iso(T0 + 40 * MIN) });
  const added = r.step(input(T0, [quiz]));
  assert.equal(added.length, 1);
  assert.equal(added[0]!.title, 'Due in 40 min: Quiz');
  assert.equal(r.step(input(T0 + 5 * MIN, [quiz])).length, 0, 'the larger 24 h stage is not sent afterwards');
});

test('a changed due date re-arms reminders and removes stale ones', () => {
  const r = runner(only('due-soon'));
  const essay = task('mock:essay', { dueAt: iso(T0 + 20 * HOUR) });
  assert.equal(r.step(input(T0, [essay])).length, 1);
  const moved = { ...essay, dueAt: iso(T0 + 22 * HOUR) };
  const added = r.step(input(T0 + MIN, [moved]));
  assert.equal(added.length, 1, 'new dueAt → new reminder');
  assert.equal(r.state.items.length, 1, 'reminder for the old due time was resolved');
  assert.equal(r.state.items[0]!.dueAt, moved.dueAt);
});

test('done tasks are skipped and completing a task resolves its reminders', () => {
  const r = runner(only('due-soon', 'overdue'));
  const done = task('mock:done', { dueAt: iso(T0 + HOUR), done: true, doneReason: 'checked-in-taskpet' });
  const open = task('mock:open', { dueAt: iso(T0 + HOUR) });
  const late = task('mock:late', { dueAt: iso(T0 - HOUR) });
  assert.deepEqual(r.step(input(T0, [done, open, late])).map(i => i.taskIds[0]).sort(), ['mock:late', 'mock:open']);
  r.step(input(T0 + MIN, [done, { ...open, done: true, doneReason: 'checked-in-taskpet' }, late]));
  assert.deepEqual(r.state.items.map(i => i.taskIds[0]), ['mock:late']);
  r.step(input(T0 + 2 * MIN, [done]));
  assert.equal(r.state.items.length, 0, 'tasks that disappeared are resolved too');
});

test('overdue and missing fire once; very old items are left alone', () => {
  const r = runner(only('overdue'));
  const late = task('canvas:assignment:1', { provider: 'canvas', title: 'Reading response', dueAt: iso(T0 - 2 * HOUR) });
  const missing = task('canvas:assignment:2', { provider: 'canvas', title: 'Worksheet', missing: true });
  const ancient = task('mock:ancient', { dueAt: iso(T0 - 45 * DAY) });
  const added = r.step(input(T0, [late, missing, ancient]));
  assert.deepEqual(added.map(i => i.title).sort(), ['Missing: Worksheet', 'Overdue: Reading response']);
  assert.equal(r.step(input(T0 + HOUR, [late, missing, ancient])).length, 0);
});

test('first remote snapshot is a silent baseline; later new tasks notify', () => {
  const r = runner(only('new-task'));
  const a = task('canvas:assignment:1', { provider: 'canvas', dueAt: iso(T0 + 3 * DAY) });
  const b = task('canvas:assignment:2', { provider: 'canvas', dueAt: iso(T0 + 4 * DAY) });
  const noSnapshot = input(T0, [], { providers: { canvas: sync('canvas', 'ready', false), notion: sync('notion', 'unconfigured', false) } });
  assert.equal(r.step(noSnapshot).length, 0);
  assert.equal(r.state.seen.canvas, null, 'no baseline before the first snapshot');
  assert.equal(r.step(input(T0, [a, b])).length, 0, 'baseline: never spam on first sync');
  const c = task('canvas:assignment:3', { provider: 'canvas', title: 'Lab 5 prelab', course: 'CHEM 101', dueAt: iso(T0 + 5 * DAY) });
  const past = task('canvas:assignment:4', { provider: 'canvas', dueAt: iso(T0 - DAY) });
  const added = r.step(input(T0 + HOUR, [a, b, c, past]));
  assert.equal(added.length, 1, 'past-dated new items do not notify');
  assert.equal(added[0]!.title, 'New in Canvas LMS: Lab 5 prelab');
  assert.equal(r.step(input(T0 + 2 * HOUR, [a, b, c, past])).length, 0);
});

test('remote due date changes notify once with old and new times', () => {
  const r = runner(only('due-changed'));
  const a = task('canvas:assignment:1', { provider: 'canvas', title: 'Project', dueAt: iso(T0 + 3 * DAY) });
  r.step(input(T0, [a]));
  const added = r.step(input(T0 + HOUR, [{ ...a, dueAt: iso(T0 + 5 * DAY) }]));
  assert.equal(added.length, 1);
  assert.equal(added[0]!.title, 'Due date moved: Project');
  assert.match(added[0]!.body, /^Was Mon, Nov 16, 9:00 AM → Wed, Nov 18, 9:00 AM/);
  assert.equal(r.step(input(T0 + 2 * HOUR, [{ ...a, dueAt: iso(T0 + 5 * DAY) }])).length, 0);
});

test('floods collapse into one summary that resolves when its tasks are done', () => {
  const r = runner(only('overdue'));
  const tasks = Array.from({ length: 5 }, (_, i) => task(`mock:t${i}`, { title: `Task ${i}`, dueAt: iso(T0 - (i + 1) * HOUR) }));
  const added = r.step(input(T0, tasks));
  assert.equal(added.length, 1);
  assert.equal(added[0]!.title, '5 tasks are overdue');
  assert.match(added[0]!.body, /\+2 more$/);
  r.step(input(T0 + MIN, tasks.map(t => ({ ...t, done: true }))));
  assert.equal(r.state.items.length, 0);
});

test('busy-stretch warning fires at most once per local day', () => {
  const r = runner(only('crunch'));
  const tasks = [1, 10, 40].map(h => task(`mock:c${h}`, { dueAt: iso(T0 + h * HOUR) }));
  assert.equal(r.step(input(T0, tasks.slice(0, 2))).length, 0, 'below threshold');
  const added = r.step(input(T0 + MIN, tasks));
  assert.equal(added.length, 1);
  assert.equal(added[0]!.title, 'Busy stretch: 3 deadlines in the next 48 hours');
  assert.equal(r.step(input(T0 + 2 * HOUR, tasks)).length, 0, 'same local day');
  const nextDay = [20, 30, 40].map(h => task(`mock:n${h}`, { dueAt: iso(T0 + DAY + h * HOUR) }));
  assert.equal(r.step(input(T0 + DAY, nextDay)).length, 1, 'a new day may warn again');
});

test('daily digest: once per date, after the chosen hour, only when something is due this week', () => {
  const r = runner(only('digest'));
  const early = Date.UTC(2026, 10, 13, 7, 0);
  const tasks = [task('mock:a', { title: 'Essay', dueAt: iso(T0 + 5 * HOUR) }), task('mock:b', { title: 'Lab', dueAt: iso(T0 + 3 * DAY) })];
  assert.equal(r.step(input(early, tasks)).length, 0, 'before the digest hour');
  assert.equal(r.step(input(T0, tasks, { providers: { canvas: sync('canvas', 'ready', true, true), notion: sync('notion', 'unconfigured', false) } })).length, 0, 'waits while a sync is running');
  const added = r.step(input(T0, tasks));
  assert.equal(added.length, 1);
  assert.equal(added[0]!.title, 'Today: 1 due · this week: 2');
  assert.equal(added[0]!.body, 'Next up: Essay · Lab');
  assert.equal(r.step(input(T0 + HOUR, tasks)).length, 0, 'once per local date');
  assert.equal(r.step(input(T0 + DAY, [])).length, 0, 'nothing due → no digest');
  assert.equal(runner(only('digest')).step(input(Date.UTC(2026, 10, 13, 20), tasks)).length, 0, 'not late in the evening');
});

test('sync problems notify once per transition and clear when healthy again', () => {
  const r = runner(only('sync-problem'));
  const at = (now: number, health: ProviderHealth) => input(now, [], { providers: { canvas: sync('canvas', health), notion: sync('notion', 'unconfigured', false) } });
  assert.equal(r.step(at(T0, 'auth-required')).length, 0, 'startup state is a baseline');
  assert.equal(r.step(at(T0 + MIN, 'ready')).length, 0);
  const added = r.step(at(T0 + 2 * MIN, 'auth-required'));
  assert.equal(added.length, 1);
  assert.equal(added[0]!.title, 'Canvas LMS needs you to sign in again');
  assert.equal(added[0]!.body, 'Token rejected.');
  assert.equal(r.step(at(T0 + 3 * MIN, 'auth-required')).length, 0, 'no repeat while unchanged');
  r.step(at(T0 + 4 * MIN, 'ready'));
  assert.ok(r.state.items.every(i => i.read), 'recovery marks the problem read');
  assert.equal(r.step(at(T0 + 5 * MIN, 'auth-required')).length, 0, 'flapping is rate-limited');
  r.step(at(T0 + 6 * MIN, 'ready'));
  assert.equal(r.step(at(T0 + 7 * HOUR, 'error')).length, 1, 'a different problem notifies');
});

test('focus-done fires when the session counter increases', () => {
  const r = runner(only('focus-done'));
  assert.equal(r.step(input(T0, [], { focusSessions: 3 })).length, 0, 'baseline');
  const added = r.step(input(T0 + MIN, [], { focusSessions: 4 }));
  assert.equal(added.length, 1);
  assert.equal(added[0]!.title, 'Focus session complete — take a short break.');
  assert.equal(r.step(input(T0 + 2 * MIN, [], { focusSessions: 4 })).length, 0);
});

test('disabled kinds and sources stay silent', () => {
  const s = defaultState(); s.prefs.enabled['due-soon'] = false; s.prefs.sources.mock = false;
  s.prefs.enabled.digest = false; s.prefs.enabled.crunch = false;
  const r = runner(s);
  assert.equal(r.step(input(T0, [task('mock:x', { dueAt: iso(T0 - HOUR) }), task('canvas:assignment:9', { provider: 'canvas', dueAt: iso(T0 + HOUR) })])).length, 0);
});

test('quiet hours keep items in the feed but suppress pop-ups', () => {
  const night = Date.UTC(2026, 10, 13, 23, 0);
  const c = new NotificationCenter({ load: () => null, save: () => {}, timeZone: TZ });
  c.update(input(night, [task('mock:q', { dueAt: iso(night + HOUR) })]));
  const status = c.status(night);
  assert.equal(status.quiet, true);
  assert.equal(status.items.length, 1);
  assert.equal(status.items[0]!.popup, false);
  assert.equal(c.status(T0).quiet, false);
});

test('prefs are validated strictly from the UI and leniently from disk', () => {
  const next = applyPrefsPatch(DEFAULT_PREFS, { leadTimesHours: [2, 48, 2], enabled: { digest: false }, quietHours: { startHour: 23 } });
  assert.deepEqual(next.leadTimesHours, [48, 2]);
  assert.equal(next.enabled.digest, false);
  assert.equal(next.quietHours.startHour, 23);
  assert.equal(next.quietHours.endHour, DEFAULT_PREFS.quietHours.endHour);
  for (const bad of [{ leadTimesHours: [] }, { leadTimesHours: [0.1] }, { leadTimesHours: [1, 2, 3, 4] }, { crunchThreshold: 1 }, { digestHour: 24 },
    { digestHour: 7.5 }, { enabled: { nope: true } }, { enabled: { digest: 'yes' } }, { quietHours: { startHour: -1 } }, { sources: { canvas: 1 } }, { volume: 3 }]) {
    assert.throws(() => applyPrefsPatch(DEFAULT_PREFS, bad), Error, JSON.stringify(bad));
  }
  const c = new NotificationCenter({ load: () => null, save: () => {}, timeZone: TZ });
  assert.throws(() => c.action('prefs', { digestHour: 99 }), /Digest hour/);
  assert.throws(() => c.action('explode', {}), /Unknown notification action/);
  const lenient = normalizeState({ prefs: { leadTimesHours: 'soon', digestHour: 6, enabled: { overdue: false, made_up: true } } });
  assert.deepEqual(lenient.prefs.leadTimesHours, [24, 2]);
  assert.equal(lenient.prefs.digestHour, 6);
  assert.equal(lenient.prefs.enabled.overdue, false);
});

test('persistence round trip, idempotent saves, and corrupt input defaults', () => {
  let stored: unknown = null, saves = 0;
  const options = { load: () => stored, save: (v: unknown) => { stored = JSON.parse(JSON.stringify(v)); saves++; }, timeZone: TZ, now: () => T0 };
  const c = new NotificationCenter(options);
  const tasks = [task('mock:p', { title: 'Problem set', dueAt: iso(T0 + HOUR) })];
  c.update(input(T0, tasks));
  const afterFirst = saves;
  assert.ok(afterFirst >= 1);
  c.update(input(T0, tasks)); c.update(input(T0 + 1000, tasks));
  assert.equal(saves, afterFirst, 'no writes when nothing changed');
  c.action('prefs', { desktop: false });
  const reloaded = new NotificationCenter(options);
  assert.deepEqual(reloaded.status(T0), c.status(T0));
  assert.equal(reloaded.status(T0).prefs.desktop, false);
  const before = reloaded.status(T0).items.map(i => i.kind).sort();
  assert.deepEqual(before, ['digest', 'due-soon']);
  reloaded.update(input(T0 + 2000, tasks));
  assert.deepEqual(reloaded.status(T0).items.map(i => i.kind).sort(), before, 'fired keys and digest date survive restarts');

  for (const junk of ['nope', 42, [], { items: 'x', fired: [], seen: { canvas: 'x' }, health: { canvas: 'sideways' }, focusSessions: -3, lastDigestDate: 'today' },
    { items: [{ id: 'a', kind: 'due-soon', title: 't', body: 'b', createdAt: 'x', read: false }, { id: 'b', kind: 'fake', title: 't', body: 'b', createdAt: 1, read: false }] }]) {
    const s = normalizeState(junk);
    assert.deepEqual(s.items, []); assert.deepEqual(s.prefs, DEFAULT_PREFS);
    assert.equal(s.seen.canvas, null); assert.equal(s.health.canvas, null); assert.equal(s.focusSessions, null); assert.equal(s.lastDigestDate, null);
  }
  const throwing = new NotificationCenter({ load: () => { throw new Error('disk'); }, save: () => { throw new Error('disk full'); }, timeZone: TZ });
  assert.doesNotThrow(() => throwing.update(input(T0, tasks)), 'background updates never throw');
  assert.throws(() => throwing.action('clear', {}), /Could not save notification changes/);
});

test('feed retention caps item count and age', () => {
  const s = only('due-soon');
  s.items = Array.from({ length: 130 }, (_, i) => ({ id: `old:${i}`, kind: 'focus-done' as const, title: 't', body: 'b', createdAt: T0 - (i < 20 ? 15 * DAY : HOUR), read: true,
    taskIds: [], provider: null, dueAt: null, taskTitle: null, url: null, popup: false }));
  const { state } = evaluate(s, input(T0, []), TZ);
  assert.equal(state.items.length, MAX_ITEMS);
  assert.ok(state.items.every(i => T0 - i.createdAt <= 14 * DAY));
});

test('read, dismiss and clear actions', () => {
  const c = new NotificationCenter({ load: () => null, save: () => {}, timeZone: TZ });
  const s = only('overdue');
  c.action('prefs', { enabled: s.prefs.enabled });
  c.update(input(T0, ['a', 'b', 'c'].map(id => task(`mock:${id}`, { dueAt: iso(T0 - HOUR) }))));
  const ids = c.status(T0).items.map(i => i.id);
  assert.equal(c.status(T0).unread, 3);
  c.action('read', { ids: [ids[0]] }); assert.equal(c.status(T0).unread, 2);
  c.action('dismiss', { id: ids[1] }); assert.equal(c.status(T0).items.length, 2);
  assert.throws(() => c.action('read', { ids: 'all' }), /Choose which/);
  assert.throws(() => c.action('dismiss', {}), /Choose a notification/);
  c.action('read', { all: true }); assert.equal(c.status(T0).unread, 0);
  c.action('clear', {}); assert.equal(c.status(T0).items.length, 0);
});

test('banner shows the most urgent unread deadline', () => {
  const item = (kind: NotificationKind, title: string, dueAt: number | null, read = false): NotificationItem => ({ id: title, kind, title: `x: ${title}`, body: '', createdAt: T0, read,
    taskIds: [title], provider: 'mock', dueAt: dueAt === null ? null : iso(dueAt), taskTitle: title, url: null, popup: true });
  assert.equal(bannerText([], T0), null);
  assert.equal(bannerText([item('due-soon', 'Lab 4', T0 + 2 * HOUR)], T0), 'DUE 2H · Lab 4');
  assert.equal(bannerText([item('due-soon', 'Soon', T0 + 20 * MIN)], T0), 'DUE <1H · Soon');
  assert.equal(bannerText([item('due-soon', 'Later', T0 + 30 * HOUR)], T0), 'DUE 2D · Later');
  assert.equal(bannerText([item('due-soon', 'Later', T0 + 5 * HOUR), item('overdue', 'Late', T0 - HOUR)], T0), 'OVERDUE · Late');
  assert.equal(bannerText([item('due-soon', 'Close', T0 + HOUR), item('overdue', 'Late', T0 - HOUR)], T0), 'DUE 1H · Close');
  assert.equal(bannerText([item('due-soon', 'Read', T0 + HOUR, true), item('digest', 'Digest', null)], T0), null);
});

test('device face draws the alert banner on the canonical 240×320 surface', () => {
  const canvas = createCanvas(FACE_WIDTH, FACE_HEIGHT);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  const pixels = () => Buffer.from(ctx.getImageData(0, 0, 240, 320).data);
  const companion = defaultCompanion(1000);
  const base = { companion, task: 'Lab 4', done: 1, total: 3, status: 'PREVIEW MODE' };
  renderFace(ctx, base, 40_000); const plain = pixels();
  renderFace(ctx, { ...base, alert: 'DUE 2H · A very long assignment title that must be clipped' }, 40_000); const alerted = pixels();
  assert.equal(canvas.width, 240); assert.equal(canvas.height, 320);
  assert.ok(!plain.equals(alerted), 'banner changes the image');
  assert.ok(alerted.every((v, i) => i % 4 !== 3 || v === 255), 'still opaque');
  const top = (buf: Buffer) => buf.subarray(0, 240 * 4 * 290);
  assert.ok(top(plain).equals(top(alerted)), 'banner only touches the footer strip');
  for (const slide of ['tasks', 'focus', 'music', 'sensors'] as const) {
    companion.displaySlide = slide;
    assert.doesNotThrow(() => renderFace(ctx, { ...base, companion, alert: 'OVERDUE · Essay' }, 40_000));
  }
});

test('Application exposes notifications in its snapshot and accepts actions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lil-deadline-notif-'));
  const app = new Application(new AppStorage(dir));
  try {
    const snap = app.snapshot();
    assert.equal(typeof snap.notifications.unread, 'number');
    assert.equal(snap.notifications.prefs.desktop, true);
    await app.action('/api/notifications/prefs', { desktop: false, leadTimesHours: [12] });
    assert.equal(app.snapshot().notifications.prefs.desktop, false);
    assert.deepEqual(new AppStorage(dir).loadNotifications() && (new AppStorage(dir).loadNotifications() as { prefs: { leadTimesHours: number[] } }).prefs.leadTimesHours, [12]);
    await assert.rejects(app.action('/api/notifications/prefs', { digestHour: 'eight' }), /Digest hour/);
  } finally { await app.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
