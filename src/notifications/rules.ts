/**
 * Notification rules: deterministic evaluation from explicit state + input + time zone.
 *
 * Browser-safe (type-only imports) so the UI can share kinds/labels/defaults. All "local day"
 * and "local hour" logic uses the given IANA time zone (the host's by default).
 *
 * Every rule fires at most once per trigger (tracked in `fired` / `seen` / dated markers), so
 * evaluate() can run every few seconds without duplicating notifications.
 */
import type { TaskView } from '../tasks/store.ts';
import type { SyncStatus } from '../tasks/sync.ts';
import type { ProviderHealth, TaskProviderId } from '../tasks/types.ts';

export const NOTIFICATIONS_SCHEMA_VERSION = 1;

export const NOTIFICATION_KINDS = ['due-soon', 'overdue', 'new-task', 'due-changed', 'crunch', 'digest', 'sync-problem', 'focus-done'] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, { label: string; hint: string }> = {
  'due-soon': { label: 'Upcoming deadlines', hint: 'Reminders before each due date' },
  overdue: { label: 'Overdue & missing', hint: 'Past due and not done, or marked missing in Canvas' },
  'new-task': { label: 'New assignments', hint: 'A new Canvas or Notion item appeared' },
  'due-changed': { label: 'Due date changes', hint: 'An instructor moved a due date' },
  crunch: { label: 'Busy stretch warning', hint: 'Several deadlines within 48 hours' },
  digest: { label: 'Daily digest', hint: 'A morning summary of today and this week' },
  'sync-problem': { label: 'Sync problems', hint: 'Canvas or Notion needs attention' },
  'focus-done': { label: 'Focus session finished', hint: 'Time for a short break' },
};

export const SOURCE_LABELS: Record<TaskProviderId, string> = { mock: 'Local task', canvas: 'Canvas LMS', notion: 'Notion' };

export interface NotificationPrefs {
  enabled: Record<NotificationKind, boolean>;
  /** Reminder stages in hours before the due time, descending, 1–3 values. */
  leadTimesHours: number[];
  /** Open tasks due within 48 h needed for a busy-stretch warning. */
  crunchThreshold: number;
  /** Local hour (0–23) after which the daily digest may appear. */
  digestHour: number;
  /** Desktop pop-ups are suppressed in quiet hours; items still land in the feed. */
  quietHours: { enabled: boolean; startHour: number; endHour: number };
  /** Show OS/browser pop-ups (also needs browser permission). */
  desktop: boolean;
  sources: Record<TaskProviderId, boolean>;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: { 'due-soon': true, overdue: true, 'new-task': true, 'due-changed': true, crunch: true, digest: true, 'sync-problem': true, 'focus-done': true },
  leadTimesHours: [24, 2],
  crunchThreshold: 3,
  digestHour: 8,
  quietHours: { enabled: true, startHour: 22, endHour: 7 },
  desktop: true,
  sources: { mock: true, canvas: true, notion: true },
};

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Host wall-clock ms. */
  createdAt: number;
  read: boolean;
  /** Tasks this item is about (empty for non-task items). Used for auto-resolve. */
  taskIds: string[];
  provider: TaskProviderId | null;
  /** Due time the item refers to (nearest for summaries). */
  dueAt: string | null;
  /** Short task title for the device banner. */
  taskTitle: string | null;
  url: string | null;
  /** Eligible for a desktop pop-up (desktop on and not created in quiet hours). */
  popup: boolean;
}

export interface SeenTask { dueAt: string | null; seenAt: number }

export interface NotificationState {
  schemaVersion: typeof NOTIFICATIONS_SCHEMA_VERSION;
  prefs: NotificationPrefs;
  /** Newest first. */
  items: NotificationItem[];
  /** One-shot trigger keys → when fired. */
  fired: Record<string, { at: number; taskId: string | null }>;
  /** Remote tasks observed so far; null until the provider's first snapshot (silent baseline). */
  seen: { canvas: Record<string, SeenTask> | null; notion: Record<string, SeenTask> | null };
  health: { canvas: ProviderHealth | null; notion: ProviderHealth | null };
  focusSessions: number | null;
  lastDigestDate: string | null;
  lastCrunchDate: string | null;
}

export interface NotificationInput {
  /** Host wall-clock ms (Date.now()). */
  now: number;
  /** Tasks from every provider (mock, canvas, notion), merged. */
  tasks: TaskView[];
  providers: { canvas: SyncStatus; notion: SyncStatus };
  /** companion.timer.sessions — increases by one when a focus session finishes. */
  focusSessions: number;
}

const HOUR = 3_600_000, DAY = 24 * HOUR;
export const MAX_ITEMS = 100;
export const ITEM_RETENTION_MS = 14 * DAY;
const FIRED_RETENTION_MS = 35 * DAY;
const SEEN_RETENTION_MS = 30 * DAY;
const OVERDUE_WINDOW_MS = 30 * DAY;
const SYNC_REPEAT_MS = 6 * HOUR;
const COLLAPSE_OVER = 3;
const REMOTE: readonly ('canvas' | 'notion')[] = ['canvas', 'notion'];
const PROVIDERS: readonly TaskProviderId[] = ['mock', 'canvas', 'notion'];
const HEALTHS: readonly ProviderHealth[] = ['unconfigured', 'ready', 'error', 'auth-required'];

// --- Time zone helpers ------------------------------------------------------------

const partFormatters = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, timeZone: string): { date: string; hour: number } {
  let f = partFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
    partFormatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(ms).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
export const localDate = (ms: number, timeZone: string) => parts(ms, timeZone).date;
export const localHour = (ms: number, timeZone: string) => parts(ms, timeZone).hour;
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const fmt = (timeZone: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone, ...options });
const fullDate = (ms: number, tz: string) => fmt(tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms);

export function inQuietHours(prefs: NotificationPrefs, now: number, timeZone: string): boolean {
  const q = prefs.quietHours;
  if (!q.enabled || q.startHour === q.endHour) return false;
  const h = localHour(now, timeZone);
  return q.startHour < q.endHour ? h >= q.startHour && h < q.endHour : h >= q.startHour || h < q.endHour;
}

/** "Due in 40 min" / "Due today" / "Due tomorrow" / "Due Friday" / "Due Nov 30". */
export function dueLabel(due: number, now: number, timeZone: string): string {
  const left = due - now;
  if (left < HOUR) return `Due in ${Math.max(1, Math.round(left / 60_000))} min`;
  const day = localDate(due, timeZone), today = localDate(now, timeZone);
  if (day === today) return 'Due today';
  if (day === addDays(today, 1)) return 'Due tomorrow';
  if (left < 6 * DAY) return `Due ${fmt(timeZone, { weekday: 'long' }).format(due)}`;
  return `Due ${fmt(timeZone, { month: 'short', day: 'numeric' }).format(due)}`;
}

// --- Normalization -----------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const iso = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
const clip = (v: string, n = 300) => v.length > n ? `${v.slice(0, n - 1)}…` : v;
const isKind = (v: unknown): v is NotificationKind => (NOTIFICATION_KINDS as readonly unknown[]).includes(v);
const isProvider = (v: unknown): v is TaskProviderId => (PROVIDERS as readonly unknown[]).includes(v);

function validLeadTimes(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > 3) return null;
  if (!v.every(h => finite(h) && h >= 0.25 && h <= 168)) return null;
  return [...new Set(v as number[])].sort((a, b) => b - a);
}

export function defaultState(): NotificationState {
  return {
    schemaVersion: NOTIFICATIONS_SCHEMA_VERSION, prefs: structuredClone(DEFAULT_PREFS), items: [], fired: {},
    seen: { canvas: null, notion: null }, health: { canvas: null, notion: null },
    focusSessions: null, lastDigestDate: null, lastCrunchDate: null,
  };
}

/** Lenient: keeps valid fields from stored prefs and defaults the rest. */
export function normalizePrefs(raw: unknown): NotificationPrefs {
  const p = structuredClone(DEFAULT_PREFS);
  if (!isObj(raw)) return p;
  if (isObj(raw.enabled)) for (const k of NOTIFICATION_KINDS) if (typeof raw.enabled[k] === 'boolean') p.enabled[k] = raw.enabled[k];
  p.leadTimesHours = validLeadTimes(raw.leadTimesHours) ?? p.leadTimesHours;
  if (isInt(raw.crunchThreshold, 2, 20)) p.crunchThreshold = raw.crunchThreshold;
  if (isInt(raw.digestHour, 0, 23)) p.digestHour = raw.digestHour;
  if (isObj(raw.quietHours)) {
    if (typeof raw.quietHours.enabled === 'boolean') p.quietHours.enabled = raw.quietHours.enabled;
    if (isInt(raw.quietHours.startHour, 0, 23)) p.quietHours.startHour = raw.quietHours.startHour;
    if (isInt(raw.quietHours.endHour, 0, 23)) p.quietHours.endHour = raw.quietHours.endHour;
  }
  if (typeof raw.desktop === 'boolean') p.desktop = raw.desktop;
  if (isObj(raw.sources)) for (const k of PROVIDERS) if (typeof raw.sources[k] === 'boolean') p.sources[k] = raw.sources[k];
  return p;
}

/** Strict: validates a partial update from the UI. Throws Error with a user-facing message. */
export function applyPrefsPatch(prefs: NotificationPrefs, patch: Record<string, unknown>): NotificationPrefs {
  const next = structuredClone(prefs);
  const bools = (value: unknown, keys: readonly string[], target: Record<string, boolean>, what: string) => {
    if (!isObj(value)) throw new Error(`${what} must be an object of on/off switches.`);
    for (const [k, v] of Object.entries(value)) {
      if (!keys.includes(k)) throw new Error(`Unknown ${what.toLowerCase()} entry: ${k}.`);
      if (typeof v !== 'boolean') throw new Error(`${what} switches must be on or off.`);
      target[k] = v;
    }
  };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'enabled') bools(value, NOTIFICATION_KINDS, next.enabled, 'Notification types');
    else if (key === 'sources') bools(value, PROVIDERS, next.sources, 'Sources');
    else if (key === 'leadTimesHours') {
      const lead = validLeadTimes(value);
      if (!lead) throw new Error('Reminder times must be 1–3 values between 0.25 hours (15 minutes) and 168 hours (7 days).');
      next.leadTimesHours = lead;
    } else if (key === 'crunchThreshold') {
      if (!isInt(value, 2, 20)) throw new Error('Busy-stretch threshold must be a whole number from 2 to 20.');
      next.crunchThreshold = value;
    } else if (key === 'digestHour') {
      if (!isInt(value, 0, 23)) throw new Error('Digest hour must be a whole hour from 0 to 23.');
      next.digestHour = value;
    } else if (key === 'quietHours') {
      if (!isObj(value)) throw new Error('Quiet hours must be an object.');
      for (const [k, v] of Object.entries(value)) {
        if (k === 'enabled') { if (typeof v !== 'boolean') throw new Error('Quiet hours must be on or off.'); next.quietHours.enabled = v; }
        else if (k === 'startHour' || k === 'endHour') { if (!isInt(v, 0, 23)) throw new Error('Quiet hours use whole hours from 0 to 23.'); next.quietHours[k] = v; }
        else throw new Error(`Unknown quiet-hours setting: ${k}.`);
      }
    } else if (key === 'desktop') {
      if (typeof value !== 'boolean') throw new Error('Desktop pop-ups must be on or off.');
      next.desktop = value;
    } else throw new Error(`Unknown notification setting: ${key}.`);
  }
  return next;
}

function normalizeItem(raw: unknown): NotificationItem | null {
  if (!isObj(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 600 || !isKind(raw.kind)) return null;
  if (typeof raw.title !== 'string' || typeof raw.body !== 'string' || !finite(raw.createdAt) || typeof raw.read !== 'boolean') return null;
  const taskIds = Array.isArray(raw.taskIds) ? raw.taskIds.filter((x): x is string => typeof x === 'string' && x.length <= 600).slice(0, 50) : [];
  return {
    id: raw.id, kind: raw.kind, title: clip(raw.title), body: clip(raw.body, 500), createdAt: raw.createdAt, read: raw.read, taskIds,
    provider: isProvider(raw.provider) ? raw.provider : null, dueAt: iso(raw.dueAt),
    taskTitle: typeof raw.taskTitle === 'string' ? clip(raw.taskTitle) : null,
    url: typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url) ? raw.url : null,
    popup: raw.popup === true,
  };
}

function normalizeSeen(raw: unknown): Record<string, SeenTask> | null {
  if (!isObj(raw)) return null;
  const out: Record<string, SeenTask> = {};
  for (const [k, v] of Object.entries(raw)) if (isObj(v) && finite(v.seenAt) && (v.dueAt === null || iso(v.dueAt))) out[k] = { dueAt: v.dueAt as string | null, seenAt: v.seenAt };
  return out;
}

/** Validate a stored state; anything corrupt falls back to defaults field by field. */
export function normalizeState(raw: unknown): NotificationState {
  const s = defaultState();
  if (!isObj(raw)) return s;
  s.prefs = normalizePrefs(raw.prefs);
  if (Array.isArray(raw.items)) {
    const ids = new Set<string>();
    for (const value of raw.items) {
      const item = normalizeItem(value);
      if (item && !ids.has(item.id)) { ids.add(item.id); s.items.push(item); }
      if (s.items.length >= MAX_ITEMS) break;
    }
  }
  if (isObj(raw.fired)) for (const [k, v] of Object.entries(raw.fired)) {
    if (isObj(v) && finite(v.at) && (v.taskId === null || typeof v.taskId === 'string')) s.fired[k] = { at: v.at, taskId: v.taskId as string | null };
  }
  if (isObj(raw.seen)) { s.seen.canvas = normalizeSeen(raw.seen.canvas); s.seen.notion = normalizeSeen(raw.seen.notion); }
  if (isObj(raw.health)) for (const p of REMOTE) {
    const h = raw.health[p];
    s.health[p] = (HEALTHS as readonly unknown[]).includes(h) ? h as ProviderHealth : null;
  }
  if (isInt(raw.focusSessions, 0, Number.MAX_SAFE_INTEGER)) s.focusSessions = raw.focusSessions;
  const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  s.lastDigestDate = date(raw.lastDigestDate); s.lastCrunchDate = date(raw.lastCrunchDate);
  return s;
}

// --- Evaluation --------------------------------------------------------------------

const dueMs = (t: TaskView): number | null => t.dueAt ? Date.parse(t.dueAt) : null;
const taskContext = (t: TaskView, tz: string) => {
  const due = dueMs(t), bits = [t.course ?? SOURCE_LABELS[t.provider]];
  if (due !== null) bits.push(fullDate(due, tz));
  if (t.points !== null) bits.push(`${t.points} pts`);
  return bits.join(' · ');
};
const httpUrl = (u: string | null) => u && /^https?:\/\//i.test(u) ? u : null;

const SUMMARY_TITLES: Partial<Record<NotificationKind, (n: number) => string>> = {
  'due-soon': n => `${n} tasks due soon`,
  overdue: n => `${n} tasks are overdue`,
  'new-task': n => `${n} new tasks arrived`,
  'due-changed': n => `${n} due dates changed`,
};

/**
 * Evaluate every rule once. Returns a NEW state (the input state is not modified) and the
 * items added in this pass. Deterministic for a given state, input and time zone.
 */
export function evaluate(previous: NotificationState, input: NotificationInput, timeZone: string): { state: NotificationState; added: NotificationItem[] } {
  const s = structuredClone(previous), p = s.prefs, now = input.now;
  const popup = p.desktop && !inQuietHours(p, now, timeZone);
  const byId = new Map(input.tasks.map(t => [t.id, t]));
  const open = input.tasks.filter(t => !t.done && p.sources[t.provider]);
  const pending: NotificationItem[] = [];
  const make = (kind: NotificationKind, id: string, title: string, body: string, extra: Partial<NotificationItem> = {}): NotificationItem => ({
    id, kind, title: clip(title), body: clip(body, 500), createdAt: now, read: false, taskIds: [], provider: null, dueAt: null, taskTitle: null, url: null, popup, ...extra,
  });
  const forTask = (t: TaskView): Partial<NotificationItem> => ({ taskIds: [t.id], provider: t.provider, dueAt: t.dueAt, taskTitle: t.title, url: httpUrl(t.url) });
  const fire = (key: string, taskId: string | null): boolean => {
    if (s.fired[key]) return false;
    s.fired[key] = { at: now, taskId }; return true;
  };

  // 1. Auto-resolve items whose tasks are done, gone, or rescheduled.
  s.items = s.items.filter(item => {
    if (!item.taskIds.length) return true;
    const live = item.taskIds.map(id => byId.get(id)).filter(t => t && !t.done) as TaskView[];
    if (!live.length) return false;
    if ((item.kind === 'due-soon' || item.kind === 'overdue') && item.taskIds.length === 1 && live[0]!.dueAt !== item.dueAt) return false;
    return true;
  });

  // 2. Upcoming deadline reminders (one per stage; a late-added task gets only its tightest stage).
  if (p.enabled['due-soon']) for (const t of open) {
    const due = dueMs(t);
    if (due === null || due <= now) continue;
    const stages = p.leadTimesHours.filter(h => due - now <= h * HOUR);
    if (!stages.length) continue;
    const tightest = Math.min(...stages);
    if (fire(`due:${t.id}:${t.dueAt}:${tightest}`, t.id)) {
      pending.push(make('due-soon', `due:${t.id}:${t.dueAt}:${tightest}`, `${dueLabel(due, now, timeZone)}: ${t.title}`, taskContext(t, timeZone), forTask(t)));
    }
    for (const h of stages) fire(`due:${t.id}:${t.dueAt}:${h}`, t.id);
  }

  // 3. Overdue / missing.
  if (p.enabled.overdue) for (const t of open) {
    const due = dueMs(t);
    const recent = due === null || now - due <= OVERDUE_WINDOW_MS;
    if (!((due !== null && due <= now && recent) || (t.missing && recent))) continue;
    const key = `overdue:${t.id}:${t.dueAt ?? 'none'}`;
    if (fire(key, t.id)) pending.push(make('overdue', key, `${t.missing ? 'Missing' : 'Overdue'}: ${t.title}`, taskContext(t, timeZone), forTask(t)));
  }

  // 4. New remote tasks and moved due dates (silent baseline on first snapshot).
  for (const provider of REMOTE) {
    if (!input.providers[provider].snapshot) continue;
    const tasks = input.tasks.filter(t => t.provider === provider);
    if (s.seen[provider] === null) {
      s.seen[provider] = Object.fromEntries(tasks.map(t => [t.id, { dueAt: t.dueAt, seenAt: now }]));
      continue;
    }
    const seen = s.seen[provider]!, notify = p.sources[provider];
    for (const t of tasks) {
      const prev = seen[t.id], due = dueMs(t);
      if (!prev) {
        seen[t.id] = { dueAt: t.dueAt, seenAt: now };
        if (notify && p.enabled['new-task'] && !t.done && (due === null || due > now)) {
          pending.push(make('new-task', `new:${t.id}:${now}`, `New in ${SOURCE_LABELS[provider]}: ${t.title}`, taskContext(t, timeZone), forTask(t)));
        }
      } else if (prev.dueAt !== t.dueAt) {
        const before = prev.dueAt ? Date.parse(prev.dueAt) : null;
        prev.dueAt = t.dueAt; prev.seenAt = now;
        if (notify && p.enabled['due-changed'] && !t.done && due !== null && due > now) {
          const body = `${before === null ? 'Now dated' : `Was ${fullDate(before, timeZone)}`} → ${fullDate(due, timeZone)} · ${t.course ?? SOURCE_LABELS[provider]}`;
          pending.push(make('due-changed', `moved:${t.id}:${t.dueAt}`, `Due date moved: ${t.title}`, body, forTask(t)));
        }
      } else if (now - prev.seenAt > DAY) prev.seenAt = now;
    }
    const present = new Set(tasks.map(t => t.id));
    for (const [id, entry] of Object.entries(seen)) if (!present.has(id) && now - entry.seenAt > SEEN_RETENTION_MS) delete seen[id];
  }

  const today = localDate(now, timeZone);
  const upcoming = (ms: number) => open.filter(t => { const due = dueMs(t); return due !== null && due > now && due <= now + ms; })
    .sort((a, b) => dueMs(a)! - dueMs(b)!);
  const list = (tasks: TaskView[]) => tasks.slice(0, 3).map(t => t.title).join(' · ') + (tasks.length > 3 ? ` · +${tasks.length - 3} more` : '');

  // 5. Busy stretch: many deadlines within 48 h (once per local day).
  if (p.enabled.crunch && s.lastCrunchDate !== today) {
    const soon = upcoming(2 * DAY);
    if (soon.length >= p.crunchThreshold) {
      s.lastCrunchDate = today;
      pending.push(make('crunch', `crunch:${today}`, `Busy stretch: ${soon.length} deadlines in the next 48 hours`, list(soon),
        { taskIds: soon.map(t => t.id), dueAt: soon[0]!.dueAt }));
    }
  }

  // 6. Daily digest (once per local date, in a window after the chosen hour, when something is due this week).
  const hour = localHour(now, timeZone), syncing = REMOTE.some(r => input.providers[r].refreshing);
  if (p.enabled.digest && s.lastDigestDate !== today && !syncing && hour >= p.digestHour && hour < p.digestHour + 6) {
    const week = upcoming(7 * DAY);
    if (week.length) {
      const dueToday = week.filter(t => localDate(dueMs(t)!, timeZone) === today).length;
      const overdue = open.filter(t => { const due = dueMs(t); return due !== null && due <= now && now - due <= OVERDUE_WINDOW_MS; }).length;
      s.lastDigestDate = today;
      pending.push(make('digest', `digest:${today}`, `Today: ${dueToday} due · this week: ${week.length}`,
        `${overdue ? `${overdue} overdue · ` : ''}Next up: ${list(week)}`));
    }
  }

  // 7. Sync problems (once per transition; the same problem repeats at most every 6 h).
  for (const provider of REMOTE) {
    const status = input.providers[provider].provider, health = status.health, prev = s.health[provider];
    s.health[provider] = health;
    if (health === 'ready') for (const item of s.items) if (item.kind === 'sync-problem' && item.provider === provider) item.read = true;
    if (prev === null || prev === health || (health !== 'auth-required' && health !== 'error') || !p.enabled['sync-problem']) continue;
    const key = `sync:${provider}:${health}`, last = s.fired[key];
    if (last && now - last.at < SYNC_REPEAT_MS) continue;
    s.fired[key] = { at: now, taskId: null };
    pending.push(make('sync-problem', `${key}:${now}`,
      health === 'auth-required' ? `${status.label} needs you to sign in again` : `${status.label} refresh failed`,
      `${status.message ?? 'The last good snapshot is still shown.'}`, { provider }));
  }

  // 8. Focus session finished.
  const prevSessions = s.focusSessions;
  s.focusSessions = input.focusSessions;
  if (prevSessions !== null && input.focusSessions > prevSessions && p.enabled['focus-done']) {
    pending.push(make('focus-done', `focus:${input.focusSessions}:${now}`, 'Focus session complete — take a short break.',
      `${input.focusSessions} session${input.focusSessions === 1 ? '' : 's'} so far. Stretch, sip some water, then pick the next little thing.`));
  }

  // Collapse floods (e.g. first run with many overdue items) into one summary per kind.
  const added: NotificationItem[] = [];
  for (const kind of NOTIFICATION_KINDS) {
    const group = pending.filter(item => item.kind === kind);
    const summary = SUMMARY_TITLES[kind];
    if (group.length > COLLAPSE_OVER && summary) {
      const sorted = [...group].sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity));
      const first = sorted[0]!;
      added.push(make(kind, `summary:${kind}:${now}`, summary(group.length),
        sorted.slice(0, 3).map(i => i.taskTitle ?? i.title).join(' · ') + ` · +${group.length - 3} more`,
        { taskIds: group.flatMap(i => i.taskIds), dueAt: first.dueAt, taskTitle: first.taskTitle ? `${first.taskTitle} +${group.length - 1}` : null }));
    } else added.push(...group);
  }
  const ids = new Set(s.items.map(i => i.id));
  for (const item of added) {
    let id = item.id, n = 2;
    while (ids.has(id)) id = `${item.id}#${n++}`;
    item.id = id; ids.add(id);
  }
  s.items = [...added, ...s.items].filter(i => now - i.createdAt <= ITEM_RETENTION_MS).slice(0, MAX_ITEMS);

  // Forget old one-shot keys that can no longer re-fire.
  for (const [key, entry] of Object.entries(s.fired)) {
    if (now - entry.at <= FIRED_RETENTION_MS) continue;
    const task = entry.taskId ? byId.get(entry.taskId) : undefined;
    if (!task || task.done) delete s.fired[key];
  }
  return { state: s, added };
}

/** Short device-face text for the most urgent unread deadline item, or null. */
export function bannerText(items: readonly NotificationItem[], now: number): string | null {
  let best: { score: number; text: string } | null = null;
  for (const item of items) {
    if (item.read || (item.kind !== 'due-soon' && item.kind !== 'overdue')) continue;
    const due = item.dueAt ? Date.parse(item.dueAt) : null, subject = item.taskTitle ?? item.title;
    let score: number, text: string;
    if (item.kind === 'overdue' || due === null || due <= now) { score = 3 * HOUR; text = `OVERDUE · ${subject}`; }
    else {
      const left = due - now; score = left;
      text = `DUE ${left < HOUR ? '<1H' : left < DAY ? `${Math.ceil(left / HOUR)}H` : `${Math.ceil(left / DAY)}D`} · ${subject}`;
    }
    if (!best || score < best.score) best = { score, text };
  }
  return best?.text ?? null;
}
