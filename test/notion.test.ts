import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { NotionTaskProvider } from '../src/notion/provider.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { TaskSync } from '../src/tasks/sync.ts';
const row = (id: string) => ({ object: 'page', id, url: `https://app.notion.com/p/${id}`, properties: { Name: { type: 'title', title: [{ plain_text: 'Read a chapter' }] }, Due: { date: { start: '2026-11-14' } }, Done: { checkbox: true }, Category: { select: { name: 'Reading' } } } });
test('Notion imports paginated tasks with stable IDs, private auth, and local completion', async () => {
  const token = randomBytes(32).toString('hex'), id = randomUUID(), pageId = randomUUID(); let calls = 0;
  const provider = new NotionTaskProvider(() => ({ token, dataSourceId: id }), (async (url, options) => {
    assert.equal(String(url), `https://api.notion.com/v1/data_sources/${id}/query`);
    assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${token}`);
    assert.equal(options?.redirect, 'error'); assert.equal(options?.method, 'POST');
    calls++;
    if (calls === 1) return Response.json({ results: [row(pageId)], has_more: true, next_cursor: 'opaque:cursor' });
    assert.equal(JSON.parse(String(options?.body)).start_cursor, 'opaque:cursor');
    return Response.json({ results: [row(pageId)], has_more: false, next_cursor: null });
  }) as typeof fetch);
  const snapshot = await provider.refresh(); assert.equal(snapshot.tasks.length, 1); assert.equal(snapshot.tasks[0]!.key, pageId);
  assert.equal(snapshot.tasks[0]!.status.markedDone, true); assert.equal(snapshot.tasks[0]!.course?.name, 'Reading');
  let data: unknown = null;
  const store = new TaskStore({ persistence: { load: () => data, save: value => { data = structuredClone(value); } } });
  store.applySnapshot(snapshot);
  assert.equal(new TaskStore({ persistence: { load: () => data, save: () => {} } }).list('notion').length, 1);
  assert.ok(!JSON.stringify(data).includes(token)); assert.equal(calls, 2);
});
test('Notion failed sync retains last good snapshot; 401 pauses and long rate limits are bounded', async () => {
  const token = randomBytes(32).toString('hex'), id = randomUUID(); let code = 200;
  const provider = new NotionTaskProvider(() => ({ token, dataSourceId: id }), (async () => code === 200
    ? Response.json({ results: [row(id)], has_more: false })
    : new Response('private upstream error', { status: code, headers: { 'Retry-After': '90' } })) as typeof fetch);
  const store = new TaskStore({ persistence: { load: () => null, save: () => {} } });
  const sync = new TaskSync({ provider, store, intervalMs: () => 60000 });
  try {
    assert.equal(await sync.refreshNow(), true); assert.equal(store.list('notion').length, 1);
    code = 429; assert.equal(await sync.refreshNow(), false); assert.equal(store.list('notion').length, 1); assert.equal(provider.status().health, 'error');
    code = 401; assert.equal(await sync.refreshNow(), false); assert.equal(provider.status().health, 'auth-required'); assert.equal(sync.status().paused, true);
    assert.ok(!JSON.stringify(provider.status()).includes(token));
  } finally { sync.stop(); }
});
