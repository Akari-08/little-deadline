// Canvas LMS (coursework) provider + planner mapping tests. Loopback mock server only.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CanvasTaskProvider } from '../src/canvas/provider.ts';
import { PersonalTokenAuth } from '../src/canvas/personal-token.ts';
import { mapPlannerItems, normalizeTimestamp, plannerKind, safeCanvasUrl } from '../src/canvas/planner.ts';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/host/storage.ts';
import { ProviderAuthError } from '../src/tasks/types.ts';
import { FAKE_CANVAS_TOKEN, linkHeader, startMockCanvas, type MockCanvas } from './helpers/mock-canvas-server.ts';

const BASE = 'https://canvas.example.edu';
const NOW = new Date('2026-11-13T12:00:00.000Z');

const servers: MockCanvas[] = [];
afterEach(async () => {
  for (const mock of servers.splice(0)) {
    assert.deepEqual(mock.violations, []);
    for (const req of mock.requests) {
      assert.ok(['/api/v1/planner/items', '/api/v1/courses'].includes(req.path), `unexpected endpoint ${req.path}`);
    }
    await mock.close();
  }
});

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    context_type: 'Course', course_id: 101, plannable_id: 5001, plannable_type: 'assignment',
    plannable: { id: 5001, name: 'Essay 1', due_at: '2026-11-20T23:59:00Z', points_possible: 10 },
    planner_override: null,
    submissions: { excused: false, graded: false, late: false, missing: false, needs_grading: false, with_feedback: false },
    html_url: '/courses/101/assignments/5001',
    ...overrides,
  };
}

function setup(options: {
  handler?: MockCanvas['handler'];
  token?: string | null;
  baseUrl?: string;
} = {}) {
  return (async () => {
    const mock = await startMockCanvas(options.handler ? { handler: options.handler } : {});
    servers.push(mock);
    const settings: AppSettings['canvas'] = { ...DEFAULT_SETTINGS.canvas, baseUrl: options.baseUrl ?? mock.origin };
    let token: string | null = options.token === undefined ? FAKE_CANVAS_TOKEN : options.token;
    const provider = new CanvasTaskProvider({
      loadSettings: () => settings,
      createAuth: () => (token ? new PersonalTokenAuth({ loadToken: () => token }) : null),
      now: () => NOW, maxRetries: 0, timeoutMs: 2000, sleep: async () => {},
    });
    return { mock, provider, settings, setToken: (value: string | null) => { token = value; } };
  })();
}

// --- planner mapping (pure) -----------------------------------------------------------------

test('maps planner items: kinds, keys, UTC due dates, URLs, points and course names', () => {
  const { tasks, skipped, duplicates } = mapPlannerItems([
    item({ context_name: 'Biology 101' }),
    item({
      plannable_type: 'planner_note', plannable_id: '77', course_id: undefined,
      plannable: { title: '  Buy\nlab  goggles ', todo_date: '2026-11-15T09:00:00-05:00' }, submissions: false,
      html_url: undefined,
    }),
    item({ plannable_type: 'discussion_topic', plannable_id: 9, plannable: { title: 'Week 3 forum' }, plannable_date: '2026-11-14T10:00:00+02:00' }),
    item({ plannable_type: 'calendar_event', plannable_id: 3, plannable: { title: 'Lab', start_at: '2026-11-16T15:00:00Z' }, submissions: false }),
  ], { baseUrl: BASE, courseNames: new Map([['101', 'BIO 101 (from courses)']]) });
  assert.equal(skipped, 0);
  assert.equal(duplicates, 0);
  assert.deepEqual(tasks.map(t => [t.key, t.kind, t.dueAt]), [
    ['discussion_topic:9', 'discussion', '2026-11-14T08:00:00.000Z'],
    ['planner_note:77', 'note', '2026-11-15T14:00:00.000Z'],
    ['calendar_event:3', 'event', '2026-11-16T15:00:00.000Z'],
    ['assignment:5001', 'assignment', '2026-11-20T23:59:00.000Z'],
  ]);
  const essay = tasks.find(t => t.key === 'assignment:5001')!;
  assert.equal(essay.title, 'Essay 1');
  assert.deepEqual(essay.course, { id: '101', name: 'Biology 101' });
  assert.equal(essay.url, 'https://canvas.example.edu/courses/101/assignments/5001');
  assert.equal(essay.points, 10);
  const note = tasks.find(t => t.key === 'planner_note:77')!;
  assert.equal(note.title, 'Buy lab goggles');
  assert.equal(note.course, null);
  assert.equal(note.url, null);
  assert.equal(tasks.find(t => t.key === 'discussion_topic:9')!.course?.name, 'BIO 101 (from courses)');
});

test('status flags come from submissions (object or false) and planner_override', () => {
  const { tasks } = mapPlannerItems([
    item({ plannable_id: 1, submissions: { submitted: true, graded: true, late: true } }),
    item({ plannable_id: 2, planner_override: { id: 9, marked_complete: true, dismissed: false } }),
    item({ plannable_id: 3, submissions: { missing: true, excused: false } }),
    item({ plannable_id: 4, submissions: false, planner_override: { marked_complete: 'yes' } }),
    item({ plannable_id: 5, submissions: { excused: true, missing: 'true' } }),
  ], { baseUrl: BASE });
  const status = Object.fromEntries(tasks.map(t => [t.key, t.status]));
  const none = { submitted: false, markedDone: false, missing: false, late: false, graded: false, excused: false };
  assert.deepEqual(status['assignment:1'], { ...none, submitted: true, graded: true, late: true });
  assert.deepEqual(status['assignment:2'], { ...none, markedDone: true });
  assert.deepEqual(status['assignment:3'], { ...none, missing: true });
  assert.deepEqual(status['assignment:4'], none);
  assert.deepEqual(status['assignment:5'], { ...none, excused: true });
});

test('undated items, untrusted URLs, duplicates and invalid items are handled defensively', () => {
  const { tasks, skipped, duplicates } = mapPlannerItems([
    item({ plannable_id: 1, plannable: { name: 'No date' } }),
    item({ plannable_id: 2, html_url: 'https://evil.example/phish' }),
    item({ plannable_id: 3, html_url: 'javascript:alert(1)' }),
    item({ plannable_id: 4, html_url: '//evil.example/x' }),
    item({ plannable_id: 5, plannable: { name: 'Bad date', due_at: 'next tuesday', points_possible: -3 } }),
    item({ plannable_id: 1, plannable: { name: 'Duplicate of 1' } }),
    item({ plannable_id: '1', plannable: { name: 'String id duplicate' } }),
    null, 'nope', [],
    item({ plannable_id: undefined }),
    item({ plannable_type: 42 }),
    item({ plannable_id: 'has spaces in id' }),
    item({ plannable_id: -1 }),
    item({ plannable: 'not an object' }),
  ], { baseUrl: BASE });
  assert.equal(skipped, 8);
  assert.equal(duplicates, 2);
  const byKey = new Map(tasks.map(t => [t.key, t]));
  assert.equal(byKey.size, 5);
  assert.equal(byKey.get('assignment:1')!.title, 'No date');
  assert.equal(byKey.get('assignment:1')!.dueAt, null);
  assert.equal(byKey.get('assignment:2')!.url, null);
  assert.equal(byKey.get('assignment:3')!.url, null);
  assert.equal(byKey.get('assignment:4')!.url, null);
  assert.equal(byKey.get('assignment:5')!.dueAt, null);
  assert.equal(byKey.get('assignment:5')!.points, null);
  assert.equal(tasks.at(-1)!.dueAt, null, 'undated items sort last');
});

test('helpers: timestamps, kinds and URLs', () => {
  assert.equal(normalizeTimestamp('2026-11-20T23:59:59-06:00'), '2026-11-21T05:59:59.000Z');
  assert.equal(normalizeTimestamp('2026-11-20T23:59:59.5+0530'), '2026-11-20T18:29:59.500Z');
  assert.equal(normalizeTimestamp('2026-11-20'), '2026-11-20T00:00:00.000Z');
  assert.equal(normalizeTimestamp('2026-13-45T00:00:00Z'), null);
  assert.equal(normalizeTimestamp(1700000000), null);
  assert.equal(plannerKind('quiz'), 'quiz');
  assert.equal(plannerKind('assessment_request'), 'event');
  assert.equal(plannerKind('wiki_page'), 'page');
  assert.equal(plannerKind('something_new'), 'other');
  assert.equal(safeCanvasUrl('https://canvas.example.edu/courses/1', BASE), 'https://canvas.example.edu/courses/1');
  assert.equal(safeCanvasUrl('https://user:pw@canvas.example.edu/', BASE), null);
});

// --- provider against the loopback mock -----------------------------------------------------

test('unconfigured until a valid address and credentials exist; no requests are made', async () => {
  const empty = await setup({ baseUrl: '' });
  assert.equal(empty.provider.status().health, 'unconfigured');
  assert.match(empty.provider.status().message ?? '', /canvas-url/);
  await assert.rejects(empty.provider.refresh(), /not set up/);

  const insecure = await setup({ baseUrl: 'http://canvas.example.edu' });
  assert.equal(insecure.provider.status().health, 'unconfigured');
  assert.match(insecure.provider.status().message ?? '', /https/);

  const noToken = await setup({ token: null });
  const status = noToken.provider.status();
  assert.equal(status.health, 'unconfigured');
  assert.equal(status.provider, 'canvas');
  assert.equal(status.label, 'Canvas LMS');
  assert.match(status.message ?? '', /canvas-token/);
  await assert.rejects(noToken.provider.refresh(), ProviderAuthError);
  for (const ctx of [empty, insecure, noToken]) assert.equal(ctx.mock.requests.length, 0);
});

test('refresh reads all planner pages for the configured window and reports ready', async () => {
  const pages = [
    [item({ plannable_id: 1, context_name: 'Biology 101' }), item({ plannable_id: 2, context_name: 'Biology 101' })],
    [item({ plannable_id: 3, context_name: 'Biology 101', planner_override: { marked_complete: true } })],
    [item({ plannable_id: 4, context_name: 'Biology 101', submissions: { submitted: true } }), 'junk'],
  ];
  const ctx = await setup({
    handler: req => {
      const page = Number(req.query.get('page') ?? '0');
      const headers: Record<string, string> = page + 1 < pages.length
        ? { Link: linkHeader({ next: `${ctx.mock.origin}/api/v1/planner/items?page=${page + 1}&per_page=100` }) } : {};
      return { headers, body: pages[page] };
    },
  });
  assert.equal(ctx.provider.status().health, 'ready');
  assert.equal(ctx.provider.status().lastSuccessAt, null);
  const snapshot = await ctx.provider.refresh();
  assert.equal(snapshot.provider, 'canvas');
  assert.equal(snapshot.fetchedAt, NOW.toISOString());
  assert.deepEqual(snapshot.tasks.map(t => t.key), ['assignment:1', 'assignment:2', 'assignment:3', 'assignment:4']);
  assert.equal(ctx.mock.requests.length, 3, 'context_name present: no course lookup');
  const first = ctx.mock.requests[0]!;
  assert.equal(first.query.get('start_date'), '2026-11-06T12:00:00.000Z');
  assert.equal(first.query.get('end_date'), '2026-12-04T12:00:00.000Z');
  assert.equal(first.query.get('per_page'), '100');
  const status = ctx.provider.status();
  assert.equal(status.health, 'ready');
  assert.equal(status.lastSuccessAt, NOW.toISOString());
  assert.match(status.message ?? '', /4 items.*1 unreadable item skipped/);
  assert.equal(ctx.provider.lastSnapshot(), snapshot);
  assert.ok(!JSON.stringify(status).includes(FAKE_CANVAS_TOKEN));
});

test('course names are fetched once when context_name is absent; failure there is not fatal', async () => {
  let coursesOk = true;
  const ctx = await setup({
    handler: req => {
      if (req.path === '/api/v1/courses') {
        if (!coursesOk) return { status: 403, body: { errors: [{ message: 'nope' }] } };
        return { body: [{ id: 101, name: 'Biology 101', course_code: 'BIO101' }, { id: 'bad id' }, { id: 102, course_code: 'CHEM' }] };
      }
      return { body: [item({ plannable_id: 1 }), item({ plannable_id: 2, course_id: 102 }), item({ plannable_id: 3, course_id: 999 })] };
    },
  });
  const snapshot = await ctx.provider.refresh();
  assert.deepEqual(snapshot.tasks.map(t => t.course?.name ?? null), ['Biology 101', 'CHEM', null]);
  const courseReq = ctx.mock.requests.find(r => r.path === '/api/v1/courses')!;
  assert.equal(courseReq.query.get('enrollment_state'), 'active');
  assert.equal(ctx.mock.requests.length, 2);

  coursesOk = false;
  const degraded = await ctx.provider.refresh();
  assert.deepEqual(degraded.tasks.map(t => t.course?.name ?? null), [null, null, null]);
  assert.equal(ctx.provider.status().health, 'ready');
  assert.match(ctx.provider.status().message ?? '', /course names unavailable/);
});

test('401 with a personal token → auth-required; the last snapshot is kept', async () => {
  let revoked = false;
  const ctx = await setup({ handler: () => (revoked ? { status: 401, body: { errors: [{ message: 'Invalid access token.' }] } } : { body: [item({ context_name: 'X' })] }) });
  const good = await ctx.provider.refresh();
  revoked = true;
  await assert.rejects(ctx.provider.refresh(), (error: unknown) => {
    assert.ok(error instanceof ProviderAuthError);
    assert.ok(!error.message.includes(FAKE_CANVAS_TOKEN));
    return true;
  });
  const status = ctx.provider.status();
  assert.equal(status.health, 'auth-required');
  assert.match(status.message ?? '', /expired or been revoked/);
  assert.equal(status.lastSuccessAt, NOW.toISOString());
  assert.equal(ctx.provider.lastSnapshot(), good);
});

test('malformed JSON → error health, last good snapshot and lastSuccessAt retained', async () => {
  let broken = false;
  const ctx = await setup({ handler: () => ({ body: broken ? '{"oops"' : [item({ context_name: 'X' })] }) });
  const good = await ctx.provider.refresh();
  broken = true;
  await assert.rejects(ctx.provider.refresh(), /not valid JSON/);
  const status = ctx.provider.status();
  assert.equal(status.health, 'error');
  assert.match(status.message ?? '', /^Canvas refresh failed: .*Showing the last tasks fetched\.$/);
  assert.equal(status.lastSuccessAt, NOW.toISOString());
  assert.equal(ctx.provider.lastSnapshot(), good);
  assert.equal(good.tasks.length, 1);

  broken = false;
  await ctx.provider.refresh();
  assert.equal(ctx.provider.status().health, 'ready');
});

test('a cancelled refresh does not mark the provider as failed', async () => {
  const ctx = await setup({ handler: () => 'hang' });
  const controller = new AbortController();
  const pending = ctx.provider.refresh(controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending);
  assert.equal(ctx.provider.status().health, 'ready');
});

test('changing the Canvas address discards the snapshot of the previous institution', async () => {
  const ctx = await setup({ handler: () => ({ body: [item({ context_name: 'X' })] }) });
  await ctx.provider.refresh();
  assert.ok(ctx.provider.lastSnapshot());
  ctx.settings.baseUrl = 'https://other.example.edu';
  assert.equal(ctx.provider.lastSnapshot(), null);
  assert.equal(ctx.provider.status().lastSuccessAt, null);
});
