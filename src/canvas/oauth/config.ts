/**
 * Canvas LMS OAuth2 client configuration ("Sign in with Canvas").
 *
 * The client ID (and, for confidential keys, the client secret) come from an API developer
 * key issued by the institution's Canvas admins. Until one is configured, OAuth sign-in is
 * unavailable and the UI/CLI must say so. See docs/canvas-oauth-setup.md.
 *
 * Redirect URI: Canvas checks the redirect_uri against the developer key's "Redirect URIs"
 * (exact match) or, leniently, the legacy single redirect URI's scheme + host. To work with
 * exact matching, TaskPet uses ONE fixed loopback URI by default:
 *   http://127.0.0.1:51735/oauth/callback
 */
import { parseCanvasBaseUrl } from '../base-url.ts';

export const DEFAULT_REDIRECT_PORT = 51735;
export const CALLBACK_HOST = '127.0.0.1';
export const CALLBACK_PATH = '/oauth/callback';

/**
 * Canvas API scopes TaskPet needs (format `url:<VERB>|<path>` per the Canvas developer key
 * docs). Read-only: planner items, the user's course list and their own user record.
 */
export const DEFAULT_SCOPES: readonly string[] = Object.freeze([
  'url:GET|/api/v1/planner/items',
  'url:GET|/api/v1/courses',
  'url:GET|/api/v1/users/:id',
]);

export const USER_AGENT = 'TaskPet/0.1 (local desktop companion; read-only Canvas LMS client)';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CanvasOAuthConfig {
  /** Canvas institution origin, e.g. https://canvas.example.edu (validated). */
  origin: string;
  clientId: string;
  /** null for a public-client developer key used with PKCE. Never log. */
  clientSecret: string | null;
  /** Fixed loopback port registered with the institution (0 = ephemeral, tests only). */
  redirectPort: number;
  /** Scopes to request; empty = omit the scope parameter (unscoped developer key). */
  scopes: readonly string[];
  /** Send PKCE S256 parameters (supported by current Canvas source; harmless if ignored). */
  usePkce: boolean;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: FetchLike;
  /** Timeout for each token-endpoint request. */
  requestTimeoutMs?: number;
}

export interface OAuthConfigInput {
  baseUrl: string;
  clientId: string;
  clientSecret: string | null;
  redirectPort?: number;
  scopes?: readonly string[];
  usePkce?: boolean;
}

export type OAuthConfigResult =
  | { ok: true; config: CanvasOAuthConfig }
  | { ok: false; problems: string[] };

export function redirectUriFor(port: number): string {
  return `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`;
}

/** Validate settings into a usable OAuth config. Messages never contain the client secret. */
export function resolveOAuthConfig(input: OAuthConfigInput): OAuthConfigResult {
  const problems: string[] = [];
  let origin = '';
  if (!input.baseUrl.trim()) {
    problems.push("Canvas address is not set (npm run configure -- canvas-url https://canvas.example.edu).");
  } else {
    const parsed = parseCanvasBaseUrl(input.baseUrl);
    if (parsed.ok) origin = parsed.origin;
    else problems.push(`Canvas address: ${parsed.error}`);
  }
  const clientId = input.clientId.trim();
  if (!clientId) {
    problems.push('No OAuth client ID. Your institution\'s Canvas admins must issue an API developer key for TaskPet (see docs/canvas-oauth-setup.md).');
  } else if (!/^[A-Za-z0-9._~-]{1,200}$/.test(clientId)) {
    problems.push('The OAuth client ID should be the developer key ID shown in Canvas (letters/digits only).');
  }
  const usePkce = input.usePkce ?? true;
  const clientSecret = input.clientSecret && input.clientSecret.length > 0 ? input.clientSecret : null;
  if (!clientSecret && !usePkce) {
    problems.push('A client secret is required unless the developer key is a public client used with PKCE.');
  }
  const redirectPort = input.redirectPort ?? DEFAULT_REDIRECT_PORT;
  if (!Number.isInteger(redirectPort) || redirectPort < 0 || redirectPort > 65535) {
    problems.push('Redirect port must be an integer from 1 to 65535.');
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: { origin, clientId, clientSecret, redirectPort, scopes: [...(input.scopes ?? DEFAULT_SCOPES)], usePkce },
  };
}

/** Settings + secret store shape this module needs (a subset of AppStorage). */
export interface OAuthSettingsSource {
  loadSettings(): { canvas: { baseUrl: string; oauthClientId: string } };
  loadCanvasOAuthClientSecret(): string | null;
}

export function loadOAuthConfig(
  storage: OAuthSettingsSource,
  overrides: Omit<Partial<OAuthConfigInput>, 'baseUrl' | 'clientId' | 'clientSecret'> = {},
): OAuthConfigResult {
  const { canvas } = storage.loadSettings();
  return resolveOAuthConfig({
    baseUrl: canvas.baseUrl,
    clientId: canvas.oauthClientId,
    clientSecret: storage.loadCanvasOAuthClientSecret(),
    ...overrides,
  });
}
