/**
 * CanvasAuth backed by "Sign in with Canvas" (OAuth2) tokens.
 *
 * - accessToken() returns the stored token, refreshing first when it expires within
 *   `refreshMarginMs` (default 60 s). Canvas access tokens last about one hour.
 * - Refresh is single-flight: concurrent callers share one in-flight token request.
 * - Canvas omits refresh_token from refresh replies for confidential keys ("the same refresh
 *   token can be reused"); the previous one is kept. A rotated one (public clients) is saved.
 * - A refused refresh (invalid_grant, other 400/401) clears the stored tokens and throws
 *   ProviderAuthError so the UI shows "sign in again". Network/5xx/429 failures throw a plain
 *   Error and keep the tokens, so a later attempt can succeed.
 * - signOut() best-effort revokes the token at Canvas, then clears it locally regardless.
 */
import type { CanvasAuth } from '../auth.ts';
import { ProviderAuthError } from '../../tasks/types.ts';
import { redirectUriFor, type CanvasOAuthConfig } from './config.ts';
import { CanvasTokenError, refreshAccessToken, revokeAccessToken, type RevokeResult } from './token-endpoint.ts';
import type { CanvasOAuthTokens, CanvasOAuthTokenStore } from './token-store.ts';

export const NOT_SIGNED_IN_MESSAGE = 'Not signed in to Canvas. Use "Sign in with Canvas" to connect your account.';
export const SIGN_IN_EXPIRED_MESSAGE = 'Your Canvas sign-in expired — sign in again';
export const DEFAULT_REFRESH_MARGIN_MS = 60_000;
/** A 401 arriving this soon after a successful refresh is retried with the new token, not refreshed again. */
const RECENT_REFRESH_MS = 5_000;

export interface OAuth2CanvasAuthOptions {
  config: CanvasOAuthConfig;
  store: CanvasOAuthTokenStore;
  /** Wall clock, ms since epoch (expiresAt is an absolute UTC time). */
  now?: () => number;
  refreshMarginMs?: number;
}

export interface SignOutResult extends RevokeResult {
  /** Tokens were present before sign-out. They are always cleared locally. */
  wasSignedIn: boolean;
}

export interface CanvasSignInStatus {
  signedIn: boolean;
  userId: string | null;
  expiresAt: string | null;
  /** Access token already past its expiry (a refresh will be attempted on next use). */
  accessTokenExpired: boolean;
  hasRefreshToken: boolean;
}

/** Safe-to-display sign-in facts. Never includes token values. */
export function describeSignIn(store: CanvasOAuthTokenStore, now: number = Date.now()): CanvasSignInStatus {
  const tokens = store.load();
  if (!tokens) return { signedIn: false, userId: null, expiresAt: null, accessTokenExpired: false, hasRefreshToken: false };
  const expiry = tokens.expiresAt ? Date.parse(tokens.expiresAt) : NaN;
  return {
    signedIn: true,
    userId: tokens.userId,
    expiresAt: tokens.expiresAt,
    accessTokenExpired: Number.isFinite(expiry) && expiry <= now,
    hasRefreshToken: tokens.refreshToken !== null,
  };
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('Cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export class OAuth2CanvasAuth implements CanvasAuth {
  readonly kind = 'oauth2' as const;
  private readonly config: CanvasOAuthConfig;
  private readonly store: CanvasOAuthTokenStore;
  private readonly now: () => number;
  private readonly refreshMarginMs: number;
  private inflight: Promise<string> | null = null;
  /** Bumped by signOut so a refresh that finishes afterwards cannot resurrect tokens. */
  private generation = 0;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;

  constructor(opts: OAuth2CanvasAuthOptions) {
    this.config = opts.config;
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.refreshMarginMs = opts.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
  }

  status(): CanvasSignInStatus {
    return describeSignIn(this.store, this.now());
  }

  async accessToken(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('Cancelled');
    if (this.inflight) return abortable(this.inflight, signal);
    const tokens = this.store.load();
    if (!tokens) throw new ProviderAuthError(NOT_SIGNED_IN_MESSAGE);
    if (!this.needsRefresh(tokens)) return tokens.accessToken;
    return this.refresh(signal);
  }

  async handleUnauthorized(signal?: AbortSignal): Promise<boolean> {
    if (this.inflight) {
      await abortable(this.inflight, signal);
      return true;
    }
    const tokens = this.store.load();
    if (!tokens) return false;
    if (this.now() - this.lastRefreshAt < RECENT_REFRESH_MS) return true;
    // No refresh token: nothing to try. Tokens are kept, because Canvas also answers 401
    // when the developer key lacks a scope for the endpoint, which re-signing cannot fix.
    if (!tokens.refreshToken) return false;
    await this.refresh(signal);
    return true;
  }

  /** Best-effort revoke at Canvas (DELETE /login/oauth2/token), then clear local tokens regardless. */
  async signOut(opts: { expireSessions?: boolean; signal?: AbortSignal } = {}): Promise<SignOutResult> {
    this.generation++;
    this.inflight = null;
    const tokens = this.store.load();
    let result: RevokeResult = { revoked: false, status: null, forwardUrl: null };
    try {
      if (tokens) {
        result = await revokeAccessToken(this.config, tokens.accessToken, opts, opts.signal);
        if (!result.revoked && result.status === 401 && tokens.refreshToken) {
          // The access token already expired; get a fresh one only to revoke the grant.
          try {
            const fresh = await refreshAccessToken(this.config,
              { refreshToken: tokens.refreshToken, redirectUri: redirectUriFor(this.config.redirectPort) }, opts.signal);
            result = await revokeAccessToken(this.config, fresh.accessToken, opts, opts.signal);
          } catch { /* best effort */ }
        }
      }
    } finally {
      this.store.save(null);
    }
    return { ...result, wasSignedIn: tokens !== null };
  }

  private needsRefresh(tokens: CanvasOAuthTokens): boolean {
    if (tokens.expiresAt === null) return false; // unknown lifetime: rely on 401 → handleUnauthorized
    const expiry = Date.parse(tokens.expiresAt);
    if (!Number.isFinite(expiry)) return true;
    return expiry - this.now() <= this.refreshMarginMs;
  }

  private refresh(signal?: AbortSignal): Promise<string> {
    if (!this.inflight) {
      const run = this.doRefresh(this.generation);
      const shared = run.finally(() => { if (this.inflight === shared) this.inflight = null; });
      shared.catch(() => {}); // a caller that aborts early must not leave an unhandled rejection
      this.inflight = shared;
    }
    return abortable(this.inflight, signal);
  }

  private async doRefresh(generation: number): Promise<string> {
    const tokens = this.store.load();
    if (!tokens) throw new ProviderAuthError(NOT_SIGNED_IN_MESSAGE);
    if (!tokens.refreshToken) {
      this.clearIfUnchanged(generation, tokens);
      throw new ProviderAuthError(SIGN_IN_EXPIRED_MESSAGE);
    }
    try {
      // Not tied to any one caller's signal: other callers share this request. It has its own timeout.
      const reply = await refreshAccessToken(this.config,
        { refreshToken: tokens.refreshToken, redirectUri: redirectUriFor(this.config.redirectPort) });
      if (generation !== this.generation) throw new ProviderAuthError(NOT_SIGNED_IN_MESSAGE);
      const updated: CanvasOAuthTokens = {
        accessToken: reply.accessToken,
        refreshToken: reply.refreshToken ?? tokens.refreshToken,
        expiresAt: reply.expiresIn !== null ? new Date(this.now() + reply.expiresIn * 1000).toISOString() : null,
        userId: reply.userId ?? tokens.userId,
      };
      this.store.save(updated);
      this.lastRefreshAt = this.now();
      return updated.accessToken;
    } catch (error) {
      if (error instanceof CanvasTokenError && error.kind !== 'transient') {
        this.clearIfUnchanged(generation, tokens);
        throw new ProviderAuthError(error.kind === 'client'
          ? `${error.message} Then sign in to Canvas again.`
          : SIGN_IN_EXPIRED_MESSAGE);
      }
      throw error;
    }
  }

  /** Clear tokens unless the user signed out or signed in again meanwhile. */
  private clearIfUnchanged(generation: number, used: CanvasOAuthTokens): void {
    if (generation !== this.generation) return;
    const current = this.store.load();
    if (current && current.accessToken === used.accessToken && current.refreshToken === used.refreshToken) {
      this.store.save(null);
    }
  }
}

/** Convenience for CLIs: revoke + clear without constructing the auth object yourself. */
export function signOutOfCanvas(
  config: CanvasOAuthConfig,
  store: CanvasOAuthTokenStore,
  opts: { expireSessions?: boolean; signal?: AbortSignal } = {},
): Promise<SignOutResult> {
  return new OAuth2CanvasAuth({ config, store }).signOut(opts);
}
