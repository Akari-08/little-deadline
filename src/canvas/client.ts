/**
 * Read-only HTTP client for the Canvas LMS REST API (Canvas LMS = coursework, not the Canvas 2D
 * render surface). Host process only.
 *
 * Safety properties:
 *  - GET only. There is deliberately no method for POST/PUT/DELETE.
 *  - The token is sent solely as `Authorization: Bearer` to the configured origin. It is never put
 *    in a URL, and redirects are not followed (a redirect could carry the header elsewhere).
 *  - Pagination follows the `Link: <...>; rel="next"` header as an opaque URL, but only while it
 *    stays on the configured origin.
 *  - One request at a time (Canvas throttles parallel requests more heavily).
 *  - Error messages never contain the token, headers, or more than a short sanitized body snippet.
 *
 * API references (verified 2026-11-13):
 *  https://canvas.instructure.com/doc/api/file.pagination.html
 *  https://canvas.instructure.com/doc/api/file.throttling.html
 *  https://canvas.instructure.com/doc/api/file.oauth.html
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { CanvasAuth } from './auth.ts';
import { ProviderAuthError } from '../tasks/types.ts';

export const CANVAS_USER_AGENT = 'TaskPet/0.1 (local desktop app)';

export type CanvasErrorKind =
  | 'http'        // non-retryable HTTP status (e.g. 403/404) or retries exhausted on 5xx
  | 'rate-limit'  // throttled (429 / 403 "Rate Limit Exceeded") and retries exhausted
  | 'network'     // DNS/TCP/TLS failure
  | 'timeout'     // no complete response within timeoutMs
  | 'redirect'    // 3xx: refused rather than followed
  | 'pagination'  // unsafe or looping next link, or a page that is not a JSON array
  | 'json';       // response body is not valid JSON

export class CanvasApiError extends Error {
  readonly kind: CanvasErrorKind;
  readonly status: number | null;
  constructor(kind: CanvasErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'CanvasApiError';
    this.kind = kind;
    this.status = status;
  }
}

export type QueryValue = string | number | boolean | readonly (string | number)[];
export type Query = Record<string, QueryValue | undefined>;

export interface PaginatedResult<T> {
  items: T[];
  pages: number;
  /** True when maxPages was reached while Canvas still offered a next page. */
  truncated: boolean;
}

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface CanvasClientOptions {
  /** Origin from parseCanvasBaseUrl, e.g. https://canvas.example.edu */
  baseUrl: string;
  auth: CanvasAuth;
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout including reading the body. */
  timeoutMs?: number;
  /** Retries for 429/5xx/network/timeout failures (not counting the single 401 re-auth retry). */
  maxRetries?: number;
  sleep?: SleepFn;
  random?: () => number;
  maxPages?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** Longest Retry-After the client will wait; longer requests fail instead of hanging. */
  maxRetryAfterMs?: number;
}

const defaultSleep: SleepFn = (ms, signal) => delay(ms, undefined, signal ? { signal } : undefined);

const isPrintableToken = (token: string) => /^[\x21-\x7e]{1,4096}$/.test(token);

/** Collapse whitespace, strip control characters and cap length. */
function snippet(text: string, max = 120): string {
  const clean = text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Best-effort short description of a Canvas error body: `{"errors":[{"message":"..."}]}` etc. */
function describeErrorBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const errors = record.errors;
      if (Array.isArray(errors) && errors[0] && typeof errors[0] === 'object') {
        const message = (errors[0] as Record<string, unknown>).message;
        if (typeof message === 'string') return snippet(message);
      }
      if (typeof record.message === 'string') return snippet(record.message);
      if (typeof record.error === 'string') return snippet(record.error);
    }
  } catch { /* not JSON */ }
  // HTML error pages are noise; keep only plain-text bodies.
  return /^\s*</.test(body) ? '' : snippet(body);
}

/** Parse an RFC 8288 Link header and return the target of rel="next", if any. */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  const pattern = /<([^>]*)>((?:\s*;\s*[^;,"=]+(?:=\s*(?:"[^"]*"|[^;,]*))?)*)/g;
  for (const match of header.matchAll(pattern)) {
    const params = match[2] ?? '';
    for (const param of params.matchAll(/;\s*([^;=\s]+)\s*=\s*(?:"([^"]*)"|([^;,\s]*))/g)) {
      if ((param[1] ?? '').toLowerCase() !== 'rel') continue;
      const rels = (param[2] ?? param[3] ?? '').toLowerCase().split(/\s+/);
      if (rels.includes('next')) return match[1] ?? null;
    }
  }
  return null;
}

/** Retry-After as milliseconds (delta-seconds or HTTP date), or null. */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

function appendQuery(url: URL, query: Query | undefined): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else url.searchParams.append(key, String(value));
  }
}

export class CanvasClient {
  readonly origin: string;
  private readonly auth: CanvasAuth;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: SleepFn;
  private readonly random: () => number;
  private readonly maxPages: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxRetryAfterMs: number;
  /** Serializes requests: one in flight at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Tokens seen by this client, for redaction of any message that might echo one. */
  private readonly seenTokens = new Set<string>();

  constructor(options: CanvasClientOptions) {
    let origin: string;
    try {
      origin = new URL(options.baseUrl).origin;
    } catch {
      throw new Error('Canvas address is not a valid URL');
    }
    if (origin === 'null') throw new Error('Canvas address is not a valid URL');
    this.origin = origin;
    this.auth = options.auth;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 3);
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.maxPages = Math.max(1, options.maxPages ?? 50);
    this.backoffInitialMs = options.backoffInitialMs ?? 1000;
    this.backoffMaxMs = options.backoffMaxMs ?? 30_000;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 120_000;
  }

  /** GET a single JSON document. `path` is relative to the origin, e.g. `/api/v1/users/self`. */
  async getJson(path: string, query?: Query, signal?: AbortSignal): Promise<unknown> {
    const { body } = await this.enqueue(() => this.request(this.buildUrl(path, query), signal));
    return body;
  }

  /** GET every page of a list endpoint, following `Link: rel="next"` on the same origin only. */
  async getPaginated<T = unknown>(path: string, query?: Query, signal?: AbortSignal): Promise<PaginatedResult<T>> {
    const items: T[] = [];
    const visited = new Set<string>();
    let url: URL | null = this.buildUrl(path, query);
    let pages = 0;
    while (url) {
      if (pages >= this.maxPages) return { items, pages, truncated: true };
      visited.add(url.href);
      const current: URL = url;
      const { body, link } = await this.enqueue(() => this.request(current, signal));
      pages++;
      if (!Array.isArray(body)) {
        throw new CanvasApiError('pagination', `Canvas returned an unexpected response for ${current.pathname} (expected a list)`);
      }
      items.push(...(body as T[]));
      const next = parseNextLink(link);
      if (next === null) break;
      let nextUrl: URL;
      try {
        nextUrl = new URL(next, current);
      } catch {
        throw new CanvasApiError('pagination', 'Canvas returned an invalid next-page link; stopped.');
      }
      if (nextUrl.origin !== this.origin) {
        throw new CanvasApiError('pagination',
          'Canvas returned a next-page link to a different address; stopped without sending credentials there.');
      }
      if (visited.has(nextUrl.href)) {
        throw new CanvasApiError('pagination', 'Canvas returned a next-page link that repeats an earlier page; stopped.');
      }
      url = nextUrl;
    }
    return { items, pages, truncated: false };
  }

  // ---------------------------------------------------------------------------------------

  private buildUrl(path: string, query: Query | undefined): URL {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Canvas API path must start with a single "/"');
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error('Canvas API path resolved to a different address');
    appendQuery(url, query);
    return url;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private redact(message: string): string {
    let out = message;
    for (const token of this.seenTokens) if (token) out = out.split(token).join('[redacted]');
    return out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  }

  private fail(kind: CanvasErrorKind, message: string, status: number | null = null): CanvasApiError {
    return new CanvasApiError(kind, this.redact(message), status);
  }

  private backoffMs(attempt: number): number {
    const cap = Math.min(this.backoffMaxMs, this.backoffInitialMs * 2 ** attempt);
    return Math.round(cap * (0.5 + 0.5 * this.random()));
  }

  private authFailureMessage(): string {
    return this.auth.kind === 'personal-token'
      ? 'Canvas rejected the access token (it may have expired or been revoked). Create a new access token in Canvas (Account > Settings > Approved Integrations > New Access Token) and save it with: npm run configure -- canvas-token'
      : 'Your Canvas sign-in has expired or was revoked. Please sign in to Canvas again.';
  }

  private async token(signal: AbortSignal | undefined): Promise<string> {
    const token = await this.auth.accessToken(signal);
    if (typeof token !== 'string' || !isPrintableToken(token)) {
      throw new ProviderAuthError('The saved Canvas credential is not valid. Please enter or sign in again.');
    }
    this.seenTokens.add(token);
    return token;
  }

  private async request(url: URL, signal: AbortSignal | undefined): Promise<{ body: unknown; link: string | null }> {
    let attempt = 0;
    let reauthorized = false;
    for (;;) {
      signal?.throwIfAborted();
      const token = await this.token(signal);
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let response: Response;
      let text: string;
      try {
        response = await this.fetchFn(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'User-Agent': CANVAS_USER_AGENT,
          },
          redirect: 'manual',
          signal: combined,
        });
        text = await response.text();
      } catch (error) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Canvas request cancelled');
        const failure = timeout.aborted
          ? this.fail('timeout', `Canvas did not respond within ${Math.round(this.timeoutMs / 1000)} s`)
          : this.fail('network', `Could not reach Canvas at ${this.origin}${describeNetworkError(error)}`);
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoffMs(attempt++), signal);
          continue;
        }
        throw failure;
      }

      const status = response.status;
      if (status >= 200 && status < 300) {
        // Canvas may prefix JSON with `while(1);` as CSRF protection for some session-based clients.
        const json = text.replace(/^\s*while\(1\);/, '');
        let body: unknown;
        try {
          body = json.trim() === '' ? null : JSON.parse(json);
        } catch {
          throw this.fail('json', `Canvas sent a response that is not valid JSON (${url.pathname})`, status);
        }
        return { body, link: response.headers.get('link') };
      }

      if (status === 0 || (status >= 300 && status < 400)) {
        throw this.fail('redirect',
          `Canvas redirected the request (HTTP ${status || 'redirect'}); not following it. Check that the Canvas address in settings is your school's exact Canvas URL.`, status || null);
      }

      if (status === 401) {
        if (!reauthorized) {
          reauthorized = true;
          if (await this.auth.handleUnauthorized(signal)) continue;
        }
        throw new ProviderAuthError(this.redact(this.authFailureMessage()));
      }

      const detail = describeErrorBody(text);
      const rateLimited = status === 429 || (status === 403 && /rate limit exceeded/i.test(text));
      if (rateLimited || status >= 500) {
        if (attempt < this.maxRetries) {
          let wait = this.backoffMs(attempt);
          if (rateLimited) {
            const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
            if (retryAfter !== null) {
              if (retryAfter > this.maxRetryAfterMs) {
                throw this.fail('rate-limit', `Canvas is rate limiting requests and asked to wait ${Math.ceil(retryAfter / 1000)} s; try again later.`, status);
              }
              wait = retryAfter;
            }
          }
          attempt++;
          await this.sleep(wait, signal);
          continue;
        }
        throw rateLimited
          ? this.fail('rate-limit', 'Canvas is rate limiting requests; try again in a few minutes.', status)
          : this.fail('http', `Canvas server error (HTTP ${status})${detail ? `: ${detail}` : ''}`, status);
      }

      const hint = status === 403 ? ' Your account may not have access to this information.'
        : status === 404 ? ' Check that the Canvas address is correct.' : '';
      throw this.fail('http', `Canvas request failed (HTTP ${status})${detail ? `: ${detail}` : ''}.${hint}`, status);
    }
  }
}

function describeNetworkError(error: unknown): string {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : null;
  return code && /^[A-Z_]{2,40}$/.test(code) ? ` (${code})` : '';
}
