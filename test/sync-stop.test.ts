import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskSync } from '../src/tasks/sync.ts';
import { TaskStore } from '../src/tasks/store.ts';
import type { ProviderSnapshot, TaskProvider } from '../src/tasks/types.ts';

test('stopping sync aborts the request and ignores a late provider result', async () => {
  let signal: AbortSignal | undefined, complete!: (s: ProviderSnapshot) => void;
  const provider: TaskProvider = { id: 'notion', status: () => ({ provider: 'notion', label: 'Notion', health: 'ready', message: null, lastSuccessAt: null }),
    refresh: s => { signal = s; return new Promise(resolve => { complete = resolve; }); } };
  const store = new TaskStore({ persistence: { load: () => null, save: () => {} } });
  const sync = new TaskSync({ provider, store, intervalMs: () => 60_000 });
  const pending = sync.refreshNow(); sync.stop(); assert.equal(signal?.aborted, true);
  complete({ provider: 'notion', fetchedAt: new Date().toISOString(), tasks: [] });
  assert.equal(await pending, false); assert.equal(store.snapshotInfo('notion'), null); assert.equal(sync.status().nextRefreshInMs, null);
});
