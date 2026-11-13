/**
 * Canvas OAuth2 token endpoint calls (POST/DELETE <origin>/login/oauth2/token).
 *
 * - Requests go ONLY to the configured Canvas origin, over HTTPS (http only for loopback test
 *   origins, enforced by parseCanvasBaseUrl), and never follow redirects, so credentials can
 *   not be forwarded to another host.
 * - Error messages are built from fixed text plus a sanitized OAuth error code; response
 *   bodies, client secrets, codes, verifiers and tokens are never included.
 */
import { USER_AGENT, type CanvasOAuthConfig } from './config.ts';

export const TOKEN_PATH = '/login/oauth2/token';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 256 * 1024;

export type TokenErrorKind =
  | 'rejected'   // the code/refresh token was refused (invalid_grant etc.): sign in again
  | 'client'     // Canvas refused TaskPet's developer key (client ID/secret)
  | 'transient'; // network, timeout, throttling, server error, malformed reply: try later

export class CanvasTokenError extends Error {
  readonly kind: TokenErrorKind;
  readonly status: number | null;
  /** OAuth `error` code such as `invalid_grant`, sanitized; null if absent. */
  readonly oauthError: string | null;

  constructor(kind: TokenErrorKind, message: string, status: number | null = null, oauthError: string | null = null) {
    super(message);
    this.name = 'CanvasTokenError';
    this.kind = kind;
    this.status = status;
    this.oauthError = oauthError;
  }
}

export interface TokenResponse {
  accessToken: string;
  /** Omitted by Canvas on refresh for confidential clients: keep the previous one. */
  refreshToken: string | null;
  /** Seconds until the access token expires (Canvas: 3600), or null if not stated. */
  expiresIn: number | null;
  userId: string | null;
}

/** OAuth error codes are short [a-z_] identifiers; anything else is dropped, not echoed. */
export function sanitizeOAuthCode(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value) ? value : null;
}

function tokenUrl(config: CanvasOAuthConfig): URL {
  // Fixed path on the validated origin; origin never comes from a server response.
  return new URL(TOKEN_PATH, config.origin);
}

function requestSignal(config: CanvasOAuthConfig, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const isObj = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function send(
  config: CanvasOAuthConfig,
  init: RequestInit,
  action: string,
  signal?: AbortSignal,
): Promise<Response> {
  const fetchFn = config.fetch ?? fetch;
  try {
    return await fetchFn(tokenUrl(config), {
      ...init,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
      redirect: 'error',
      signal: requestSignal(config, signal),
    });
  } catch (error) {
    if (signal?.aborted) throw new CanvasTokenError('transient', `${action} was cancelled.`);
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new CanvasTokenError('transient', timedOut
      ? `${action} timed out: Canvas did not answer in time. Check your connection and try again.`
      : `${action} failed: could not reach ${config.origin}. Check your connection and try again.`);
  }
}

function classifyFailure(status: number, body: unknown, action: string): CanvasTokenError {
  const code = isObj(body) ? sanitizeOAuthCode(body.error) : null;
  const suffix = code ? ` (${code})` : ` (HTTP ${status})`;
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return new CanvasTokenError('client',
      `${action} failed: Canvas did not accept TaskPet's developer key (client ID or client secret)${suffix}. `
      + 'Check the values your Canvas admins issued, or ask whether the key is still enabled.', status, code);
  }
  if (status === 400 || status === 401) {
    return new CanvasTokenError('rejected', `${action} failed: Canvas rejected the sign-in grant${suffix}.`, status, code);
  }
  if (status === 429) {
    return new CanvasTokenError('transient', `${action} failed: Canvas is rate-limiting requests; try again shortly.`, status, code);
  }
  return new CanvasTokenError('transient', `${action} failed: Canvas answered HTTP ${status}. Try again later.`, status, code);
}

function parseTokenResponse(body: unknown, action: string): TokenResponse {
  if (!isObj(body) || typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new CanvasTokenError('transient', `${action} failed: Canvas sent an unexpected reply (no access token).`);
  }
  if (body.token_type !== undefined && (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer')) {
    throw new CanvasTokenError('transient', `${action} failed: Canvas issued an unsupported token type.`);
  }
  const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0
    ? body.expires_in : null;
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token.length > 0 ? body.refresh_token : null;
  let userId: string | null = null;
  if (isObj(body.user) && (typeof body.user.id === 'number' || typeof body.user.id === 'string')) {
    const id = String(body.user.id);
    if (/^[A-Za-z0-9:_~-]{1,64}$/.test(id)) userId = id;
  }
  return { accessToken: body.access_token, refreshToken, expiresIn, userId };
}

function baseParams(config: CanvasOAuthConfig, grantType: string, redirectUri: string): URLSearchParams {
  const params = new URLSearchParams({ grant_type: grantType, client_id: config.clientId, redirect_uri: redirectUri });
  if (config.clientSecret) params.set('client_secret', config.clientSecret);
  return params;
}

async function postToken(config: CanvasOAuthConfig, params: URLSearchParams, action: string, signal?: AbortSignal): Promise<TokenResponse> {
  const response = await send(config, { method: 'POST', body: params }, action, signal);
  const body = await readJson(response).catch(() => null);
  if (!response.ok) throw classifyFailure(response.status, body, action);
  return parseTokenResponse(body, action);
}

/** grant_type=authorization_code. `codeVerifier` only when PKCE was used in the authorize step. */
export function exchangeAuthorizationCode(
  config: CanvasOAuthConfig,
  args: { code: string; redirectUri: string; codeVerifier: string | null },
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const params = baseParams(config, 'authorization_code', args.redirectUri);
  params.set('code', args.code);
  if (args.codeVerifier) params.set('code_verifier', args.codeVerifier);
  return postToken(config, params, 'Finishing Canvas sign-in', signal);
}

/** grant_type=refresh_token. Canvas documents redirect_uri as required here too. */
export function refreshAccessToken(
  config: CanvasOAuthConfig,
  args: { refreshToken: string; redirectUri: string },
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const params = baseParams(config, 'refresh_token', args.redirectUri);
  params.set('refresh_token', args.refreshToken);
  return postToken(config, params, 'Renewing Canvas sign-in', signal);
}

export interface RevokeResult {
  /** Canvas confirmed the token was deleted. */
  revoked: boolean;
  /** HTTP status Canvas answered, or null if it could not be reached. */
  status: number | null;
  /** Optional single-log-out URL Canvas returns for delegated (SSO) logins. */
  forwardUrl: string | null;
}

/** DELETE /login/oauth2/token with the access token as Bearer. Never throws. */
export async function revokeAccessToken(
  config: CanvasOAuthConfig,
  accessToken: string,
  opts: { expireSessions?: boolean } = {},
  signal?: AbortSignal,
): Promise<RevokeResult> {
  const init: RequestInit = { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } };
  if (opts.expireSessions) init.body = new URLSearchParams({ expire_sessions: '1' });
  let response: Response;
  try {
    response = await send(config, init, 'Signing out of Canvas', signal);
  } catch {
    return { revoked: false, status: null, forwardUrl: null };
  }
  const body = await readJson(response).catch(() => null);
  let forwardUrl: string | null = null;
  if (response.ok && isObj(body) && typeof body.forward_url === 'string') {
    try {
      const url = new URL(body.forward_url);
      if (url.protocol === 'https:') forwardUrl = url.href;
    } catch { /* ignore */ }
  }
  return { revoked: response.ok, status: response.status, forwardUrl };
}
