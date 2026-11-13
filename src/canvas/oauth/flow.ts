/**
 * "Sign in with Canvas": OAuth2 authorization code flow for a local desktop app.
 *
 *   const session = await startCanvasSignIn({ config, store });
 *   openInBrowser(session.authorizeUrl);          // the user's normal browser
 *   const result = await session.result;          // tokens are saved to `store`
 *
 * The user enters their school credentials only on the institution's own Canvas/SSO page.
 * TaskPet never asks for, sees or stores the password. Canvas redirects the browser to a
 * one-shot receiver on 127.0.0.1, which checks `state`, exchanges the code (with the PKCE
 * verifier) at <origin>/login/oauth2/token and stores the tokens.
 */
import type { CanvasOAuthConfig } from './config.ts';
import { startLoopbackServer, type CallbackPage, type CallbackParams } from './loopback-server.ts';
import { createPkcePair, randomUrlSafe, type PkcePair } from './pkce.ts';
import { CanvasTokenError, exchangeAuthorizationCode } from './token-endpoint.ts';
import type { CanvasOAuthTokenStore } from './token-store.ts';

export const DEFAULT_SIGN_IN_TIMEOUT_MS = 5 * 60_000;
export const AUTHORIZE_PATH = '/login/oauth2/auth';

export type SignInErrorCode =
  | 'access_denied'   // the user declined in Canvas
  | 'oauth_error'     // Canvas redirected back with another OAuth error
  | 'token_error'     // the code exchange failed
  | 'timeout'
  | 'cancelled';

export class CanvasSignInError extends Error {
  readonly code: SignInErrorCode;
  constructor(code: SignInErrorCode, message: string) {
    super(message);
    this.name = 'CanvasSignInError';
    this.code = code;
  }
}

export interface SignInOptions {
  config: CanvasOAuthConfig;
  store: CanvasOAuthTokenStore;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Ask Canvas to show its login form even if the browser already has a Canvas session. */
  forceLogin?: boolean;
  /** Shown by Canvas in the user's Approved Integrations list. */
  purpose?: string;
  /** Wall clock (ms since epoch) used to compute expiresAt. */
  now?: () => number;
}

export interface SignInResult {
  userId: string | null;
  /** ISO 8601 UTC, or null if Canvas did not state a lifetime. */
  expiresAt: string | null;
  hasRefreshToken: boolean;
}

export interface SignInSession {
  /** Open this in the user's default browser. Contains no secrets (client ID, state, PKCE challenge). */
  readonly authorizeUrl: string;
  readonly redirectUri: string;
  /** Address the receiver listens on (always 127.0.0.1). */
  readonly listenAddress: string;
  readonly port: number;
  /** Resolves once tokens are saved; rejects with CanvasSignInError (messages are user-facing, secret-free). */
  readonly result: Promise<SignInResult>;
  cancel(): void;
}

/** Lets the user recognise this app under Canvas > Account > Settings > Approved Integrations. */
export const DEFAULT_PURPOSE = 'TaskPet desktop app';

export function buildAuthorizeUrl(
  config: CanvasOAuthConfig,
  args: { redirectUri: string; state: string; pkce: PkcePair | null; forceLogin?: boolean; purpose?: string },
): string {
  const url = new URL(AUTHORIZE_PATH, config.origin);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('state', args.state);
  // One space-separated scope parameter (a repeated parameter would keep only the last).
  if (config.scopes.length > 0) url.searchParams.set('scope', config.scopes.join(' '));
  if (args.pkce) {
    url.searchParams.set('code_challenge', args.pkce.challenge);
    url.searchParams.set('code_challenge_method', args.pkce.method);
  }
  if (args.purpose) url.searchParams.set('purpose', args.purpose);
  if (args.forceLogin) url.searchParams.set('force_login', '1');
  return url.href;
}

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'You chose not to authorize TaskPet in Canvas. Nothing was saved.',
  invalid_scope: 'Canvas refused the requested permissions (invalid_scope). The developer key must include the '
    + 'scopes listed in docs/canvas-oauth-setup.md; ask your Canvas admins to add them.',
  unauthorized_client: 'Canvas says TaskPet\'s developer key is not allowed to sign in (unauthorized_client). '
    + 'Ask your Canvas admins to check that the key is enabled.',
  invalid_client: 'Canvas did not recognise TaskPet\'s client ID (invalid_client). Check the client ID your Canvas admins issued.',
  invalid_request: 'Canvas rejected the sign-in request (invalid_request). The redirect URI registered on the developer key '
    + 'may not match the one TaskPet uses; see docs/canvas-oauth-setup.md.',
  login_required: 'Canvas needs you to log in. Start sign-in again.',
  interaction_required: 'Canvas needs you to confirm access. Start sign-in again.',
};

function sanitizeCode(value: string): string | null {
  return /^[a-z0-9_.-]{1,64}$/i.test(value) ? value : null;
}

export async function startCanvasSignIn(opts: SignInOptions): Promise<SignInSession> {
  const { config, store } = opts;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS;
  if (opts.signal?.aborted) throw new CanvasSignInError('cancelled', 'Canvas sign-in was cancelled.');

  const state = randomUrlSafe(32);
  const pkce = config.usePkce ? createPkcePair() : null;
  const exchangeAbort = new AbortController();

  let settle!: { resolve: (r: SignInResult) => void; reject: (e: Error) => void };
  let settled = false;
  const result = new Promise<SignInResult>((resolve, reject) => { settle = { resolve, reject }; });
  // Mark handled so an un-awaited session cannot crash the process; callers still see rejections.
  result.catch(() => {});

  let redirectUri = '';
  const onCallback = async (params: CallbackParams): Promise<CallbackPage> => {
    if (settled) return { status: 410, title: 'Already finished', message: 'This sign-in has already finished. You can close this tab.' };
    if (params.error !== null) {
      const code = sanitizeCode(params.error);
      const message = (code && OAUTH_ERROR_MESSAGES[code])
        ?? `Canvas sign-in did not complete${code ? ` (${code})` : ''}. Return to TaskPet and try again.`;
      finish(new CanvasSignInError(code === 'access_denied' ? 'access_denied' : 'oauth_error', message));
      return code === 'access_denied'
        ? { status: 200, title: 'Sign-in cancelled', message: 'You did not authorize TaskPet. You can close this tab.' }
        : { status: 400, title: 'Sign-in failed', message: 'Canvas did not complete the sign-in. Return to TaskPet for details.' };
    }
    if (!params.code) {
      finish(new CanvasSignInError('oauth_error', 'Canvas returned without an authorization code. Try signing in again.'));
      return { status: 400, title: 'Sign-in failed', message: 'Canvas did not complete the sign-in. Return to TaskPet for details.' };
    }
    try {
      const tokens = await exchangeAuthorizationCode(
        config, { code: params.code, redirectUri, codeVerifier: pkce?.verifier ?? null }, exchangeAbort.signal);
      if (settled) throw new CanvasSignInError('cancelled', 'Canvas sign-in was cancelled.');
      const expiresAt = tokens.expiresIn !== null ? new Date(now() + tokens.expiresIn * 1000).toISOString() : null;
      store.save({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt, userId: tokens.userId });
      finish(null, { userId: tokens.userId, expiresAt, hasRefreshToken: tokens.refreshToken !== null });
      return { status: 200, title: 'Signed in', message: 'TaskPet is now connected to Canvas. You can close this tab.' };
    } catch (error) {
      const message = error instanceof CanvasTokenError || error instanceof CanvasSignInError
        ? error.message : 'Finishing Canvas sign-in failed. Try again.';
      finish(error instanceof CanvasSignInError ? error : new CanvasSignInError('token_error', message));
      return { status: 502, title: 'Sign-in failed', message: 'TaskPet could not finish signing in. Return to TaskPet for details.' };
    }
  };

  const server = await startLoopbackServer({ port: config.redirectPort, expectedState: state, onCallback });
  redirectUri = server.redirectUri;

  const timer = setTimeout(() => finish(new CanvasSignInError('timeout',
    `Canvas sign-in timed out after ${Math.round(timeoutMs / 1000)} s. Nothing was saved; start sign-in again.`)), timeoutMs);
  const onAbort = () => finish(new CanvasSignInError('cancelled', 'Canvas sign-in was cancelled.'));
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  function finish(error: Error | null, value?: SignInResult): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    if (error) {
      exchangeAbort.abort();
      settle.reject(error);
    } else {
      settle.resolve(value!);
    }
    void server.close();
  }

  const authorizeUrl = buildAuthorizeUrl(config, {
    redirectUri, state, pkce, forceLogin: opts.forceLogin, purpose: opts.purpose ?? DEFAULT_PURPOSE,
  });

  return {
    authorizeUrl,
    redirectUri,
    listenAddress: server.address,
    port: server.port,
    result,
    cancel: onAbort,
  };
}
