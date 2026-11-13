/**
 * Canvas LMS task provider (read-only). Canvas LMS = coursework, not the Canvas 2D surface.
 *
 * Reads the signed-in user's planner (GET /api/v1/planner/items) over a window around today and
 * maps it to RemoteTask. It never writes to Canvas: no submissions, no planner overrides, no
 * to-do "ignore", no grades. Local completion in TaskPet stays local.
 *
 * The last good snapshot is kept in memory; a failed refresh reports its error through status()
 * and leaves that snapshot in place.
 */
import type { CanvasAuth } from './auth.ts';
import { parseCanvasBaseUrl } from './base-url.ts';
import { CanvasClient, type SleepFn } from './client.ts';
import { applyCourseNames, courseNameMap, mapPlannerItems } from './planner.ts';
import type { AppSettings } from '../host/storage.ts';
import {
  ProviderAuthError,
  type ProviderHealth, type ProviderSnapshot, type ProviderStatus, type TaskProvider,
} from '../tasks/types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const LABEL = 'Canvas LMS';

export interface CanvasTaskProviderOptions {
  loadSettings: () => AppSettings['canvas'];
  /** Returns the configured auth, or null when no credentials are set up. */
  createAuth: () => CanvasAuth | null;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: SleepFn;
  random?: () => number;
  maxPages?: number;
  /** Requested page size (Canvas may return fewer per page). */
  perPage?: number;
}

type Config =
  | { ok: true; origin: string; auth: CanvasAuth; settings: AppSettings['canvas'] }
  | { ok: false; reason: 'address' | 'credentials'; message: string };

export class CanvasTaskProvider implements TaskProvider {
  readonly id = 'canvas' as const;
  private readonly options: CanvasTaskProviderOptions;
  private readonly now: () => Date;
  private snapshot: ProviderSnapshot | null = null;
  /** Origin the snapshot/health belong to; a different configured origin invalidates both. */
  private stateOrigin: string | null = null;
  private health: ProviderHealth = 'ready';
  private message: string | null = null;
  private lastSuccessAt: string | null = null;

  constructor(options: CanvasTaskProviderOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  status(): ProviderStatus {
    const config = this.config();
    if (!config.ok) return this.makeStatus('unconfigured', config.message);
    if (this.stateOrigin !== config.origin) return this.makeStatus('ready', 'Configured; not refreshed yet.', null);
    return this.makeStatus(this.health, this.message);
  }

  /** The last successfully fetched snapshot for the configured Canvas address, if any. */
  lastSnapshot(): ProviderSnapshot | null {
    const config = this.config();
    return config.ok && config.origin === this.stateOrigin ? this.snapshot : null;
  }

  async refresh(signal?: AbortSignal): Promise<ProviderSnapshot> {
    const config = this.config();
    if (!config.ok) {
      if (config.reason === 'address') throw new Error(config.message);
      throw new ProviderAuthError(config.message);
    }
    if (this.stateOrigin !== config.origin) this.resetState(config.origin);

    const { settings, origin, auth } = config;
    const client = new CanvasClient({
      baseUrl: origin, auth,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      ...(this.options.maxRetries !== undefined ? { maxRetries: this.options.maxRetries } : {}),
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      ...(this.options.random ? { random: this.options.random } : {}),
      ...(this.options.maxPages !== undefined ? { maxPages: this.options.maxPages } : {}),
    });

    try {
      const now = this.now().getTime();
      const planner = await client.getPaginated('/api/v1/planner/items', {
        start_date: new Date(now - settings.lookbackDays * DAY_MS).toISOString(),
        end_date: new Date(now + settings.lookaheadDays * DAY_MS).toISOString(),
        per_page: this.options.perPage ?? 100,
      }, signal);

      const mapped = mapPlannerItems(planner.items, { baseUrl: origin });
      let tasks = mapped.tasks;
      const notes: string[] = [];

      // `context_name` is not in the documented planner schema, so fetch course names when absent.
      if (tasks.some(task => task.course !== null && task.course.name === null)) {
        try {
          const courses = await client.getPaginated('/api/v1/courses', { enrollment_state: 'active', per_page: 100 }, signal);
          tasks = applyCourseNames(tasks, courseNameMap(courses.items));
        } catch (error) {
          if (error instanceof ProviderAuthError || signal?.aborted) throw error;
          notes.push('course names unavailable');
        }
      }

      if (mapped.skipped > 0) notes.push(`${mapped.skipped} unreadable item${mapped.skipped === 1 ? '' : 's'} skipped`);
      if (planner.truncated) notes.push('list truncated: too many pages, showing the first part only');

      const fetchedAt = this.now().toISOString();
      const snapshot: ProviderSnapshot = { provider: 'canvas', tasks, fetchedAt };
      this.snapshot = snapshot;
      this.lastSuccessAt = fetchedAt;
      this.health = 'ready';
      this.message = `${tasks.length} item${tasks.length === 1 ? '' : 's'} from the Canvas planner${notes.length ? ` (${notes.join('; ')})` : ''}.`;
      return snapshot;
    } catch (error) {
      if (signal?.aborted) throw error; // cancelled by the caller: not a provider failure
      if (error instanceof ProviderAuthError) {
        this.health = 'auth-required';
        this.message = error.message;
      } else {
        this.health = 'error';
        let reason = (error instanceof Error ? error.message : String(error)).trim() || 'unknown error';
        if (!/[.!?]$/.test(reason)) reason += '.';
        this.message = `Canvas refresh failed: ${reason}${this.snapshot ? ' Showing the last tasks fetched.' : ''}`;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------------------

  private config(): Config {
    const settings = this.options.loadSettings();
    if (!settings.baseUrl) {
      return { ok: false, reason: 'address', message: "Canvas LMS is not set up: add your school's Canvas address (npm run configure -- canvas-url https://<school>.instructure.com)." };
    }
    const parsed = parseCanvasBaseUrl(settings.baseUrl);
    if (!parsed.ok) return { ok: false, reason: 'address', message: `The saved Canvas address is not usable: ${parsed.error}` };
    const auth = this.options.createAuth();
    if (!auth) {
      return {
        ok: false,
        reason: 'credentials',
        message: 'Canvas LMS has no access token: create one in Canvas (Account > Settings > Approved Integrations) and save it with: npm run configure -- canvas-token',
      };
    }
    return { ok: true, origin: parsed.origin, auth, settings };
  }

  private resetState(origin: string): void {
    this.stateOrigin = origin;
    this.snapshot = null;
    this.lastSuccessAt = null;
    this.health = 'ready';
    this.message = null;
  }

  private makeStatus(health: ProviderHealth, message: string | null, lastSuccessAt = this.lastSuccessAt): ProviderStatus {
    return { provider: 'canvas', label: LABEL, health, message, lastSuccessAt };
  }
}
