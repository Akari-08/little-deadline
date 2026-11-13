import { setTimeout as delay } from 'node:timers/promises';
import { ProviderAuthError, type ProviderStatus, type ProviderSnapshot, type RemoteTask, type TaskProvider } from '../tasks/types.ts';

const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function notionTask(value: unknown): RemoteTask | null {
  const page = obj(value), properties = obj(page.properties);
  if (page.object !== 'page' || typeof page.id !== 'string' || page.in_trash || page.archived || page.is_archived) return null;
  const titleProp = Object.values(properties).map(obj).find(p => p.type === 'title');
  const title = Array.isArray(titleProp?.title) ? titleProp.title.map(v => { const t = obj(v); return typeof t.plain_text === 'string' ? t.plain_text : obj(t.text).content ?? ''; }).join('').slice(0, 300) : '';
  if (!title) return null;
  const due = obj(obj(properties.Due).date).start;
  const dueAt = typeof due === 'string' && Number.isFinite(Date.parse(due)) ? new Date(due).toISOString() : null;
  const category = obj(obj(properties.Category).select).name;
  const done = obj(properties.Done).checkbox === true;
  return { key: page.id, title, kind: 'other', course: typeof category === 'string' ? { id: category, name: category } : null, dueAt,
    url: typeof page.url === 'string' && /^https:\/\/(?:(?:www\.)?notion\.so|app\.notion\.com)\//.test(page.url) ? page.url : null, points: null,
    status: { submitted: false, markedDone: done, missing: false, late: false, graded: false, excused: false } };
}
export class NotionTaskProvider implements TaskProvider {
  readonly id = 'notion' as const;
  private info: ProviderStatus = { provider: 'notion', label: 'Notion', health: 'ready', message: 'Configured; not refreshed yet.', lastSuccessAt: null };
  private readonly config: () => { token: string | null; dataSourceId: string };
  private readonly fetchFn: typeof fetch;
  constructor(config: () => { token: string | null; dataSourceId: string }, fetchFn: typeof fetch = fetch) { this.config = config; this.fetchFn = fetchFn; }
  status(): ProviderStatus {
    const c = this.config();
    return c.token && /^[a-f\d-]{32,36}$/i.test(c.dataSourceId) ? this.info : { ...this.info, health: 'unconfigured', message: 'Add a Notion connection token and data source ID. Read-only import.' };
  }
  async refresh(signal?: AbortSignal): Promise<ProviderSnapshot> {
    const { token, dataSourceId } = this.config();
    if (!token || !/^[a-f\d-]{32,36}$/i.test(dataSourceId)) throw new ProviderAuthError('Configure Notion first.');
    const combined = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(30_000)]);
    try {
      const tasks = new Map<string, RemoteTask>(); let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 100; page++) {
        let response: Response | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          response = await this.fetchFn(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
            method: 'POST', redirect: 'error', signal: combined,
            headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2026-03-11', 'Content-Type': 'application/json' },
            body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
          });
          if (response.status !== 429 && response.status < 500) break;
          const seconds = Number(response.headers.get('retry-after') ?? (attempt + 1));
          await response.body?.cancel();
          if (!Number.isFinite(seconds) || seconds > 10) throw new Error('Notion is rate limited. Try again later.');
          await delay(Math.max(1, seconds) * 1000, undefined, { signal: combined });
        }
        if (!response) throw new Error('Notion request failed.');
        if (response.status === 401 || response.status === 403) throw new ProviderAuthError('Notion access denied. Check the token and share your data source with the connection.');
        if (!response.ok) throw new Error(`Notion returned HTTP ${response.status}.`);
        const chunks: Uint8Array[] = []; let bytes = 0;
        if (!response.body) throw new Error('Empty Notion response.');
        for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new Error('Notion response too large.'); chunks.push(chunk); }
        const body = obj(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (!Array.isArray(body.results) || obj(body.request_status).type === 'incomplete') throw new Error('Notion returned an incomplete snapshot.');
        for (const row of body.results) { const task = notionTask(row); if (task) tasks.set(task.key, task); }
        if (body.has_more === false) {
          const fetchedAt = new Date().toISOString();
          this.info = { ...this.info, health: 'ready', message: `${tasks.size} tasks imported. Completion stays local.`, lastSuccessAt: fetchedAt };
          return { provider: 'notion', tasks: [...tasks.values()], fetchedAt };
        }
        if (typeof body.next_cursor !== 'string' || seen.has(body.next_cursor)) throw new Error('Invalid Notion pagination.');
        cursor = body.next_cursor; seen.add(cursor);
        await delay(350, undefined, { signal: combined });
      }
      throw new Error('Notion page limit exceeded. Narrow the source.');
    } catch (error) {
      const auth = error instanceof ProviderAuthError;
      this.info = { ...this.info, health: auth ? 'auth-required' : 'error', message: auth ? error.message : 'Notion refresh failed or was rate limited. Last successful tasks are retained.' };
      throw auth ? error : new Error(this.info.message!);
    }
  }
}
