import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { Application } from '../src/host/application.ts';
import { AppStorage } from '../src/host/storage.ts';
import { createAppServer } from '../src/host/server.ts';
import { Assistant, AssistantInputError, buildRequest, describeAssistantError, validateChatMessages, type AssistantContext } from '../src/assistant/service.ts';
import { dueBucket, formatAssistantContext, localTime, relative, weekRange, formatDay } from '../src/assistant/context.ts';
import { SYSTEM_PROMPT } from '../src/assistant/prompt.ts';
import type { TaskView } from '../src/tasks/store.ts';
import type { SyncStatus } from '../src/tasks/sync.ts';

// A syntactically valid but fake key. Tests must never call the real API.
const FAKE_KEY = 'sk-ant-test-FAKEKEY-0123456789abcdef';
const HOUR = 3_600_000, DAY = 24 * HOUR;

function sync(health: SyncStatus['provider']['health'], extra: Partial<SyncStatus> = {}, message: string | null = null): SyncStatus {
  return { provider: { provider: 'canvas', label: 'Canvas LMS', health, message, lastSuccessAt: null }, refreshing: false, nextRefreshInMs: null, paused: false, snapshot: null, ...extra };
}
function task(overrides: Partial<TaskView>): TaskView {
  return { id: `mock:${Math.random()}`, provider: 'mock', title: 'Task', course: null, kind: 'assignment', dueAt: null, url: null, points: null,
    done: false, doneReason: null, missing: false, late: false, editable: true, priority: 'normal', ...overrides };
}
function context(overrides: Partial<AssistantContext> = {}): AssistantContext {
  return { now: Date.parse('2026-11-13T19:00:00Z'), timeZone: 'America/New_York', tasks: [],
    providers: { canvas: sync('unconfigured'), notion: sync('unconfigured') },
    focus: { sessions: 2, running: false, remainingMs: 25 * 60_000, selectedTaskId: null },
    music: { connected: false, track: null, artist: null },
    environment: { temperatureC: null, humidityPct: null, source: 'unavailable' }, ...overrides };
}

interface FakeScript { deltas?: string[]; stopReason?: string; error?: unknown; delayMs?: number; hang?: boolean }
function fakeClient(script: FakeScript, calls: { params: unknown; keys: string[] }) {
  return (apiKey: string) => {
    calls.keys.push(apiKey);
    return { beta: { messages: { stream(params: unknown, options?: { signal?: AbortSignal }) {
      calls.params = params;
      const listeners: ((delta: string) => void)[] = [];
      return {
        on(event: string, listener: (delta: string) => void) { if (event === 'text') listeners.push(listener); return this; },
        finalMessage: () => new Promise((resolve, reject) => {
          const signal = options?.signal;
          const abort = () => reject(new Anthropic.APIUserAbortError());
          if (signal?.aborted) return abort();
          signal?.addEventListener('abort', abort, { once: true });
          if (script.hang) return;
          setTimeout(() => {
            if (script.error) return reject(script.error);
            for (const d of script.deltas ?? []) for (const l of listeners) l(d);
            resolve({ stop_reason: script.stopReason ?? 'end_turn', content: [] });
          }, script.delayMs ?? 0);
        }),
      };
    } } } } as unknown as Anthropic;
  };
}

// --- Context builder ---------------------------------------------------------------

test('week boundaries follow the host time zone, not UTC', () => {
  // 06:30 UTC Monday = Sunday 22:30 in Los Angeles: still the previous week there.
  const now = Date.parse('2026-11-16T06:30:00Z');
  const la = localTime(now, 'America/Los_Angeles');
  assert.equal(formatDay(la.day), 'Sun 2026-11-15');
  const [mon, sun] = weekRange(la.day);
  assert.equal(formatDay(mon), 'Mon 2026-11-09');
  assert.equal(formatDay(sun), 'Sun 2026-11-15');
  const utc = localTime(now, 'UTC');
  assert.equal(formatDay(weekRange(utc.day)[0]), 'Mon 2026-11-16');
  const text = formatAssistantContext(context({ now, timeZone: 'America/Los_Angeles' }));
  assert.match(text, /Current local time: Sun 2026-11-15 22:30 \(time zone America\/Los_Angeles\)/);
  assert.match(text, /This week \(Mon–Sun\): Mon 2026-11-09 to Sun 2026-11-15/);
  assert.match(text, /Next week \(Mon–Sun\): Mon 2026-11-16 to Sun 2026-11-22/);
});

test('due buckets and relative due text', () => {
  const now = Date.parse('2026-11-13T19:00:00Z'), tz = 'America/New_York'; // Fri 14:00 local
  assert.equal(dueBucket(now - HOUR, now, tz), 'overdue');
  assert.equal(dueBucket(now + 3 * HOUR, now, tz), 'today');
  assert.equal(dueBucket(now + DAY, now, tz), 'tomorrow');
  assert.equal(dueBucket(now + 2 * DAY, now, tz), 'this week'); // Sunday
  assert.equal(dueBucket(now + 4 * DAY, now, tz), 'next week'); // Tuesday
  assert.equal(dueBucket(now + 12 * DAY, now, tz), 'later');
  assert.equal(relative(now + 40 * 60_000, now), 'in 40 min');
  assert.equal(relative(now + 5 * HOUR, now), 'in 5 h');
  assert.equal(relative(now + 3 * DAY, now), 'in 3 days');
  assert.equal(relative(now - 2 * DAY, now), '2 days ago');
});

test('context lists tasks across providers in a sensible order', () => {
  const now = Date.parse('2026-11-13T19:00:00Z');
  const tasks = [
    task({ title: 'Done essay', done: true, doneReason: 'submitted', dueAt: new Date(now - DAY).toISOString(), provider: 'canvas' }),
    task({ title: 'Read chapter', dueAt: null }),
    task({ title: 'CHEM Lab 4 report', course: 'CHEM 101', provider: 'canvas', dueAt: '2026-11-15T04:59:00Z', points: 20, url: 'https://school.instructure.com/x' }),
    task({ title: 'Missing quiz', kind: 'quiz', provider: 'canvas', missing: true, dueAt: new Date(now - 3 * HOUR).toISOString() }),
  ];
  const text = formatAssistantContext(context({ now, tasks }));
  const order = ['Missing quiz', 'CHEM Lab 4 report', 'Read chapter', 'Done essay'].map(t => text.indexOf(JSON.stringify(t)));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'open dated → open undated → done');
  assert.match(text, /\[Canvas LMS\] · course: "CHEM 101" · kind: assignment · title: "CHEM Lab 4 report" · due: Sat 2026-11-14 23:59 \(in \d+ h; tomorrow\) · points: 20 · status: open · link: https:\/\/school/);
  assert.match(text, /title: "Missing quiz" .*overdue.*missing in Canvas/);
  assert.match(text, /status: done \(submitted\)/);
  assert.match(text, /\[Local\] · kind: assignment · title: "Read chapter" · due: none/);
  assert.match(text, /<task_data>[\s\S]*<\/task_data>/);
  assert.match(text, /not instructions/);
});

test('context states unconfigured / failing providers and simulated sensors', () => {
  const text = formatAssistantContext(context({
    providers: { canvas: sync('error', { snapshot: { fetchedAt: '2026-11-13T10:00:00Z', count: 12 } }, 'Canvas timed out'), notion: sync('unconfigured') },
    environment: { temperatureC: 22.4, humidityPct: 41, source: 'simulated' },
  }));
  assert.match(text, /Canvas LMS: LAST REFRESH FAILED; last good snapshot .* 12 items\. Data may be out of date\. Message: "Canvas timed out"/);
  assert.match(text, /Notion: NOT CONFIGURED\. There is no Notion data; do not guess/);
  assert.match(text, /temperature 22\.4 °C \(SIMULATED readings, not physical\)/);
  assert.match(text, /no other calendar connected/);
  const auth = formatAssistantContext(context({ providers: { canvas: sync('auth-required'), notion: sync('ready', { snapshot: { fetchedAt: '2026-11-13T18:00:00Z', count: 3 } }) } }));
  assert.match(auth, /Canvas LMS: SIGN-IN NEEDED/);
  assert.match(auth, /Notion: connected; last good snapshot .*3 items/);
});

test('context truncation is stated, never silent', () => {
  const now = Date.parse('2026-11-13T19:00:00Z');
  const tasks = Array.from({ length: 12 }, (_, i) => task({ title: `T${i}`, dueAt: new Date(now + (i + 1) * HOUR).toISOString() }));
  tasks.push(task({ title: 'finished', done: true }));
  const text = formatAssistantContext(context({ now, tasks }), 10);
  assert.match(text, /Tasks: 13 total \(12 open, 1 done\)/);
  assert.match(text, /only the first 10 tasks are listed; 3 more were omitted \(2 open, 1 done/);
  assert.ok(text.includes('"T9"') && !text.includes('"T10"'));
  assert.doesNotMatch(formatAssistantContext(context({ now, tasks })), /omitted/);
});

// --- Request shape -------------------------------------------------------------------

test('request: frozen cached system prompt, context only in the latest user turn', () => {
  const ctx = context({ tasks: [task({ title: 'Essay' })] });
  const req = buildRequest([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'What is due?' }], ctx);
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.thinking, { type: 'adaptive' });
  assert.equal(req.output_config?.effort, 'medium');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.ok(Array.isArray(req.system) && req.system[0]!.text === SYSTEM_PROMPT && req.system[0]!.cache_control?.type === 'ephemeral');
  assert.doesNotMatch(SYSTEM_PROMPT, /20\d\d-\d\d-\d\d/, 'no dates in the cached prompt');
  assert.deepEqual(req.messages.slice(0, 2), [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
  const last = req.messages[2]!;
  assert.equal(last.role, 'user');
  assert.ok(Array.isArray(last.content));
  const [state, question] = last.content as { type: string; text: string }[];
  assert.match(state!.text, /^<app_state>/);
  assert.equal(question!.text, 'What is due?');
  // Same inputs → byte-identical request (deterministic).
  assert.equal(JSON.stringify(buildRequest([{ role: 'user', content: 'x' }], ctx)), JSON.stringify(buildRequest([{ role: 'user', content: 'x' }], ctx)));
});

test('chat input validation', () => {
  const bad: unknown[] = [undefined, [], 'hi', [{ role: 'assistant', content: 'x' }], [{ role: 'user', content: '  ' }],
    [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
    [{ role: 'user', content: 'x'.repeat(4001) }], [{ role: 'system', content: 'x' }],
    Array.from({ length: 41 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' }))];
  for (const value of bad) assert.throws(() => validateChatMessages(value), AssistantInputError, JSON.stringify(value)?.slice(0, 60));
  assert.deepEqual(validateChatMessages([{ role: 'user', content: 'q', extra: 1 }]), [{ role: 'user', content: 'q' }]);
  assert.equal(validateChatMessages(Array.from({ length: 39 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' }))).length, 39);
});

// --- Service streaming ---------------------------------------------------------------

test('streams deltas and reports stop reasons', async () => {
  const calls = { params: null as unknown, keys: [] as string[] };
  let script: FakeScript = { deltas: ['Your ', 'lab is ', 'Thursday.'] };
  const assistant = new Assistant({ loadApiKey: () => FAKE_KEY, context: () => context(), createClient: key => fakeClient(script, calls)(key) });
  const out: string[] = [];
  const result = await assistant.chat([{ role: 'user', content: 'lab?' }], d => out.push(d));
  assert.equal(out.join(''), 'Your lab is Thursday.');
  assert.deepEqual(result, { stopReason: 'end_turn', note: null });
  assert.deepEqual(calls.keys, [FAKE_KEY]);

  script = { deltas: [], stopReason: 'refusal' };
  assert.match((await assistant.chat([{ role: 'user', content: 'x' }], () => {})).note ?? '', /can’t help/);
  script = { deltas: ['long'], stopReason: 'max_tokens' };
  assert.match((await assistant.chat([{ role: 'user', content: 'x' }], () => {})).note ?? '', /cut off/);
});

test('missing key, abort and concurrency limits', async () => {
  const calls = { params: null as unknown, keys: [] as string[] };
  const none = new Assistant({ loadApiKey: () => null, context: () => context(), createClient: fakeClient({}, calls) });
  assert.equal(none.status().configured, false);
  await assert.rejects(none.chat([{ role: 'user', content: 'x' }], () => {}), /Claude API key in Settings/);
  assert.equal(calls.keys.length, 0);

  const hanging = new Assistant({ loadApiKey: () => FAKE_KEY, context: () => context(), createClient: fakeClient({ hang: true }, calls) });
  const controller = new AbortController();
  const pending = hanging.chat([{ role: 'user', content: 'x' }], () => {}, controller.signal);
  const second = hanging.chat([{ role: 'user', content: 'y' }], () => {}, controller.signal);
  await assert.rejects(hanging.chat([{ role: 'user', content: 'z' }], () => {}), /still answering/);
  controller.abort();
  assert.deepEqual(await pending, { stopReason: 'aborted', note: null });
  assert.deepEqual(await second, { stopReason: 'aborted', note: null });
});

test('API errors map to safe user-facing messages', async () => {
  const headers = new Headers();
  const cases: [unknown, RegExp][] = [
    [new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key', headers), /API key was rejected — update it in Settings/],
    [new Anthropic.RateLimitError(429, {}, 'rate', headers), /rate-limiting/],
    [new Anthropic.PermissionDeniedError(403, {}, 'no', headers), /not allowed/],
    [new Anthropic.NotFoundError(404, {}, 'model', headers), /not available/],
    [new Anthropic.BadRequestError(400, {}, 'bad', headers), /could not process/],
    [new Anthropic.InternalServerError(500, {}, 'boom', headers), /temporarily unavailable/],
    [new Anthropic.OverloadedError(529, {}, 'overloaded', headers), /overloaded/],
    [new Anthropic.APIConnectionTimeoutError(), /too long/],
    [new Anthropic.APIConnectionError({ message: 'ECONNRESET' }), /internet connection/],
    [new Error('anything'), /could not answer/],
  ];
  for (const [error, pattern] of cases) assert.match(describeAssistantError(error), pattern);
  const calls = { params: null as unknown, keys: [] as string[] };
  const assistant = new Assistant({ loadApiKey: () => FAKE_KEY, context: () => context(), createClient: fakeClient({ error: cases[0]![0] }, calls) });
  await assert.rejects(assistant.chat([{ role: 'user', content: 'x' }], () => {}), Anthropic.AuthenticationError);
});

// --- HTTP / SSE through the real local server ---------------------------------------

async function harness(script: FakeScript) {
  const dir = mkdtempSync(join(tmpdir(), 'lil-deadline-assistant-')), storage = new AppStorage(dir), app = new Application(storage);
  const calls = { params: null as unknown, keys: [] as string[] };
  // Swap in a fake-client assistant wired to the same secret store and context as the app.
  (app as { assistant: Assistant }).assistant = new Assistant({ loadApiKey: () => storage.loadAnthropicApiKey(), context: () => app.assistantContext(), createClient: fakeClient(script, calls) });
  const root = join(dir, 'public'); mkdirSync(root); writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
  const server = createAppServer(app, { root }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const chat = (body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) => fetch(`${url}/api/assistant/chat`, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-Lil-Deadline': '1', ...headers }, body: JSON.stringify(body) });
  return { storage, app, server, url, calls, chat,
    async close() { await app.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); } };
}
function parseSse(text: string) {
  return text.split('\n\n').filter(f => f.includes('data:')).map(f => ({
    event: /^event: (.*)$/m.exec(f)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(f)![1]!) as Record<string, unknown> }));
}
const ask = { messages: [{ role: 'user', content: 'What is my most urgent assignment?' }] };

test('SSE route: unconfigured, saving a key, streaming, and the key never leaks', async () => {
  const h = await harness({ deltas: ['Your **CHEM lab** ', 'is due tomorrow.'] });
  try {
    let r = await h.chat(ask);
    assert.equal(r.status, 400);
    assert.match((await r.json() as { error: string }).error, /Claude API key in Settings/);
    assert.equal(h.calls.keys.length, 0);

    r = await fetch(`${h.url}/api/settings/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lil-Deadline': '1' }, body: JSON.stringify({ token: FAKE_KEY }) });
    assert.equal(r.status, 200);
    const afterSave = await r.text();
    assert.ok(!afterSave.includes(FAKE_KEY), 'snapshot must not contain the key');
    const state = JSON.parse(afterSave);
    assert.equal(state.secrets.anthropicApiKeySet, true);
    assert.equal(state.assistant.configured, true);
    assert.ok(state.assistant.suggestions.length >= 6);

    r = await h.chat(ask);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = await r.text();
    assert.ok(!body.includes(FAKE_KEY));
    const events = parseSse(body);
    assert.deepEqual(events.map(e => e.event), ['open', 'delta', 'delta', 'done']);
    assert.equal(events.filter(e => e.event === 'delta').map(e => e.data.text).join(''), 'Your **CHEM lab** is due tomorrow.');
    assert.deepEqual(events.at(-1)!.data, { stopReason: 'end_turn', note: null });
    assert.deepEqual(h.calls.keys, [FAKE_KEY]);
    // The model saw the app's real task data (mock starter tasks) in the latest turn.
    const params = h.calls.params as { messages: { content: { text: string }[] }[] };
    assert.match(params.messages.at(-1)!.content[0]!.text, /\[Local\]/);

    const stateText = await (await fetch(`${h.url}/api/state`)).text();
    assert.ok(!stateText.includes(FAKE_KEY));

    // Clearing the key returns the route to the unconfigured error.
    await fetch(`${h.url}/api/settings/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lil-Deadline': '1' }, body: JSON.stringify({ clearToken: true }) });
    assert.equal((await h.chat(ask)).status, 400);
  } finally { await h.close(); }
});

test('SSE route: rejects cross-origin, missing header, wrong content type and bad input', async () => {
  const h = await harness({ deltas: ['x'] });
  try {
    h.storage.saveAnthropicApiKey(FAKE_KEY);
    assert.equal((await h.chat(ask, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await h.chat(ask, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await fetch(`${h.url}/api/assistant/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ask) })).status, 403);
    assert.equal((await fetch(`${h.url}/api/assistant/chat`, { method: 'GET' })).status, 403);
    assert.equal((await h.chat(ask, { 'Content-Type': 'text/plain' })).status, 400);
    assert.equal((await fetch(`${h.url}/api/assistant/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lil-Deadline': '1' }, body: '{nope' })).status, 400);
    const r = await h.chat({ messages: [{ role: 'assistant', content: 'hi' }] });
    assert.equal(r.status, 400);
    assert.match((await r.json() as { error: string }).error, /order/);
    const big = await h.chat({ messages: [{ role: 'user', content: 'x'.repeat(70_000) }] });
    assert.equal(big.status, 400);
    assert.equal(h.calls.keys.length, 0, 'no upstream call for rejected requests');
  } finally { await h.close(); }
});

test('SSE route: upstream errors become an error event; refusals a done note', async () => {
  let h = await harness({ error: new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key', new Headers()) });
  try {
    h.storage.saveAnthropicApiKey(FAKE_KEY);
    const events = parseSse(await (await h.chat(ask)).text());
    assert.deepEqual(events.map(e => e.event), ['open', 'error']);
    assert.match(String(events[1]!.data.message), /API key was rejected/);
  } finally { await h.close(); }
  h = await harness({ deltas: [], stopReason: 'refusal' });
  try {
    h.storage.saveAnthropicApiKey(FAKE_KEY);
    const events = parseSse(await (await h.chat(ask)).text());
    assert.equal(events.at(-1)!.event, 'done');
    assert.equal(events.at(-1)!.data.stopReason, 'refusal');
  } finally { await h.close(); }
});

test('SSE route: a long answer outlives requestTimeout; client disconnect aborts upstream', async () => {
  const h = await harness({ deltas: ['slow answer'], delayMs: 1500 });
  try {
    h.storage.saveAnthropicApiKey(FAKE_KEY);
    h.server.requestTimeout = 500; // far shorter than the answer; must not cut the stream
    const events = parseSse(await (await h.chat(ask)).text());
    assert.deepEqual(events.map(e => e.event), ['open', 'delta', 'done']);
  } finally { await h.close(); }

  const hang = await harness({ hang: true });
  try {
    hang.storage.saveAnthropicApiKey(FAKE_KEY);
    let upstreamAborted = false;
    const real = hang.app.assistant.chat.bind(hang.app.assistant);
    hang.app.assistant.chat = async (turns, onText, signal) => {
      signal?.addEventListener('abort', () => { upstreamAborted = true; });
      return real(turns, onText, signal);
    };
    const controller = new AbortController();
    const response = await hang.chat(ask, {}, controller.signal);
    const reader = response.body!.getReader();
    await reader.read(); // "open" event
    controller.abort();
    const deadline = Date.now() + 3000;
    while (!upstreamAborted && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(upstreamAborted, true);
  } finally { await hang.close(); }
});
