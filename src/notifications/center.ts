/**
 * NotificationCenter: host-side owner of the notification feed and preferences.
 *
 * Application calls update() every 30 s, on every task change and after the focus timer
 * settles; rule evaluation (rules.ts) is deterministic and fires each trigger once. State is
 * persisted through the supplied load/save callbacks (notifications.json, versioned) and only
 * written when something actually changed.
 */
import {
  applyPrefsPatch, bannerText, evaluate, inQuietHours, normalizeState,
  type NotificationInput, type NotificationItem, type NotificationPrefs, type NotificationState,
} from './rules.ts';

export type { NotificationInput, NotificationPrefs, NotificationKind } from './rules.ts';

export type NotificationView = NotificationItem;

export interface NotificationStatus {
  /** Newest first. */
  items: NotificationView[];
  unread: number;
  prefs: NotificationPrefs;
  /** Short text for the 240×320 device face, or null. */
  banner: string | null;
  /** Quiet hours are in effect right now (desktop pop-ups suppressed). */
  quiet: boolean;
}

export interface NotificationCenterOptions {
  load: () => unknown;
  save: (value: unknown) => void;
  /** IANA zone for local-day rules; defaults to the host's. */
  timeZone?: string;
  /** Clock used when an action re-evaluates rules; defaults to Date.now. */
  now?: () => number;
}

const hostTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export class NotificationCenter {
  private readonly options: NotificationCenterOptions;
  private readonly timeZone: string;
  private state: NotificationState;
  private savedJson: string;
  private lastInput: NotificationInput | null = null;

  constructor(options: NotificationCenterOptions) {
    this.options = options;
    this.timeZone = options.timeZone ?? hostTimeZone();
    let raw: unknown = null;
    try { raw = options.load(); } catch { raw = null; }
    this.state = normalizeState(raw);
    this.savedJson = JSON.stringify(raw ?? null) === JSON.stringify(this.state) ? JSON.stringify(this.state) : '';
  }

  /** Re-evaluate rules; persist only when something changed. Safe to call often. */
  update(input: NotificationInput): NotificationView[] {
    this.lastInput = input;
    const { state, added } = evaluate(this.state, input, this.timeZone);
    this.state = state;
    this.persist(false);
    return added;
  }

  status(now: number): NotificationStatus {
    const items = this.state.items;
    return {
      items: structuredClone(items), unread: items.filter(i => !i.read).length, prefs: structuredClone(this.state.prefs),
      banner: bannerText(items, now), quiet: inQuietHours(this.state.prefs, now, this.timeZone),
    };
  }

  /** `/api/notifications/<subpath>`. Throws Error with a user-facing message on bad input. */
  action(subpath: string, body: Record<string, unknown>): void {
    if (subpath === 'read') {
      if (body.all === true) for (const item of this.state.items) item.read = true;
      else if (Array.isArray(body.ids) && body.ids.length <= 200 && body.ids.every(id => typeof id === 'string')) {
        const ids = new Set(body.ids as string[]);
        for (const item of this.state.items) if (ids.has(item.id)) item.read = true;
      } else throw new Error('Choose which notifications to mark as read.');
    } else if (subpath === 'dismiss') {
      if (typeof body.id !== 'string' || !body.id) throw new Error('Choose a notification to dismiss.');
      this.state.items = this.state.items.filter(item => item.id !== body.id);
    } else if (subpath === 'clear') {
      this.state.items = [];
    } else if (subpath === 'prefs') {
      this.state.prefs = applyPrefsPatch(this.state.prefs, body);
      if (this.lastInput) {
        const now = (this.options.now ?? Date.now)();
        this.state = evaluate(this.state, { ...this.lastInput, now: Math.max(now, this.lastInput.now) }, this.timeZone).state;
      }
    } else throw new Error('Unknown notification action.');
    this.persist(true);
  }

  private persist(throwOnError: boolean): void {
    const json = JSON.stringify(this.state);
    if (json === this.savedJson) return;
    try {
      this.options.save(structuredClone(this.state));
      this.savedJson = json;
    } catch (error) {
      // Background evaluation keeps working in memory and retries on the next update.
      if (throwOnError) throw new Error('Could not save notification changes. Check the local data directory and retry.', { cause: error });
    }
  }
}
