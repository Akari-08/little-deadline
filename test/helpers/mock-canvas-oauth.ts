/**
 * Local mock of the Canvas LMS OAuth2 endpoints (GET /login/oauth2/auth, POST and DELETE
 * /login/oauth2/token), modelled on Instructure's documentation and canvas-lms behaviour.
 * Listens on 127.0.0.1 only. Uses fake credentials; never contacts a real Canvas instance.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

export const FAKE_CLIENT_ID = '10000000000042';
export const FAKE_CLIENT_SECRET = 'fake-client-secret-FOR-TESTS-ONLY-q7Zr';

export interface MockCanvasOAuthOptions {
  clientId?: string;
  /** null = public client (no secret; PKCE required for the code grant). */
  clientSecret?: string | null;
  /** Reject code grants whose authorize request had no PKCE challenge. */
  requirePkce?: boolean;
  accessTtlSeconds?: number;
  /** Public-client behaviour: return a new refresh token on every refresh. */
  rotateRefreshTokens?: boolean;
  /** Delay before answering refresh requests (to test single-flight). */
  refreshDelayMs?: number;
}

interface IssuedCode { redirectUri: string; challenge: string | null; method: string | null; used: boolean }

export class MockCanvasOAuth {
  readonly opts: Required<Omit<MockCanvasOAuthOptions, 'clientSecret'>> & { clientSecret: string | null };
  origin = '';
  private server: Server | null = null;
  private serial = 0;
  private readonly codes = new Map<string, IssuedCode>();
  /** access token -> refresh token of the same grant */
  readonly accessTokens = new Map<string, string>();
  readonly refreshTokens = new Set<string>();

  readonly authorizeRequests: URLSearchParams[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  readonly revokeRequests: { authorization: string | undefined; body: string }[] = [];
  refreshCount = 0;

  /** If set, the authorize step redirects back with this OAuth error instead of a code. */
  authorizeError: string | null = null;
  /** If set, every token POST answers with this status/body. */
  tokenFailure: { status: number; body: unknown } | null = null;
  /** If set, DELETE answers with this status. */
  revokeStatus: number | null = null;

  constructor(opts: MockCanvasOAuthOptions = {}) {
    this.opts = {
      clientId: opts.clientId ?? FAKE_CLIENT_ID,
      clientSecret: opts.clientSecret === undefined ? FAKE_CLIENT_SECRET : opts.clientSecret,
      requirePkce: opts.requirePkce ?? false,
      accessTtlSeconds: opts.accessTtlSeconds ?? 3600,
      rotateRefreshTokens: opts.rotateRefreshTokens ?? false,
      refreshDelayMs: opts.refreshDelayMs ?? 0,
    };
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => { res.statusCode = 500; res.end(); });
    });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  /** Issue a grant directly (as if the user had signed in earlier). */
  issueTokens(): { accessToken: string; refreshToken: string } {
    const accessToken = this.newToken('access');
    const refreshToken = this.newToken('refresh');
    this.accessTokens.set(accessToken, refreshToken);
    this.refreshTokens.add(refreshToken);
    return { accessToken, refreshToken };
  }

  private newToken(kind: string): string {
    return `mock-${kind}-${++this.serial}-${randomBytes(12).toString('hex')}`;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  private async body(req: IncomingMessage): Promise<string> {
    let data = '';
    for await (const chunk of req) data += chunk;
    return data;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    if (req.method === 'GET' && url.pathname === '/login/oauth2/auth') return this.authorize(url, res);
    if (url.pathname === '/login/oauth2/token') {
      const body = await this.body(req);
      if (req.method === 'POST') return this.token(new URLSearchParams(body), res);
      if (req.method === 'DELETE') return this.revoke(req, body, res);
    }
    this.json(res, 404, { errors: [{ message: 'not found' }] });
  }

  /** Simulates the user approving (or declining) on the Canvas login/consent page. */
  private authorize(url: URL, res: ServerResponse): void {
    const q = url.searchParams;
    this.authorizeRequests.push(q);
    if (q.get('client_id') !== this.opts.clientId) return this.json(res, 401, { error: 'invalid_client', error_description: 'unknown client' });
    const redirectUri = q.get('redirect_uri') ?? '';
    if (!redirectUri.startsWith('http://127.0.0.1:')) return this.json(res, 400, { error: 'invalid_request', error_description: 'redirect_uri does not match client settings' });
    if (q.get('response_type') !== 'code') return this.json(res, 400, { error: 'unsupported_response_type' });
    const back = new URL(redirectUri);
    const state = q.get('state');
    if (state !== null) back.searchParams.set('state', state);
    if (this.authorizeError) {
      back.searchParams.set('error', this.authorizeError);
      back.searchParams.set('error_description', 'The user denied access');
    } else {
      const code = this.newToken('code');
      this.codes.set(code, { redirectUri, challenge: q.get('code_challenge'), method: q.get('code_challenge_method'), used: false });
      back.searchParams.set('code', code);
    }
    res.writeHead(302, { Location: back.href });
    res.end();
  }

  private async token(p: URLSearchParams, res: ServerResponse): Promise<void> {
    this.tokenRequests.push(p);
    if (this.tokenFailure) return this.json(res, this.tokenFailure.status, this.tokenFailure.body);
    if (p.get('client_id') !== this.opts.clientId) return this.json(res, 401, { error: 'invalid_client', error_description: 'unknown client' });
    const secret = p.get('client_secret');
    const publicOk = this.opts.clientSecret === null && !secret;
    if (!publicOk && secret !== this.opts.clientSecret) return this.json(res, 401, { error: 'invalid_client', error_description: 'invalid client' });

    const grant = p.get('grant_type');
    if (grant === 'authorization_code') {
      const issued = this.codes.get(p.get('code') ?? '');
      if (!issued || issued.used) return this.json(res, 400, { error: 'invalid_grant', error_description: 'authorization_code not found' });
      issued.used = true;
      if (issued.redirectUri !== p.get('redirect_uri')) return this.json(res, 400, { error: 'invalid_grant' });
      if (issued.challenge) {
        const verifier = p.get('code_verifier');
        const expected = verifier ? createHash('sha256').update(verifier).digest('base64url') : null;
        if (issued.method !== 'S256' || expected !== issued.challenge) return this.json(res, 400, { error: 'invalid_grant' });
      } else if (this.opts.requirePkce || publicOk) {
        return this.json(res, 400, { error: 'invalid_grant' });
      }
      const { accessToken, refreshToken } = this.issueTokens();
      return this.json(res, 200, {
        access_token: accessToken, token_type: 'Bearer', user: { id: 42, name: 'Test Student' },
        refresh_token: refreshToken, expires_in: this.opts.accessTtlSeconds,
      });
    }
    if (grant === 'refresh_token') {
      this.refreshCount++;
      if (this.opts.refreshDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.opts.refreshDelayMs));
      const old = p.get('refresh_token') ?? '';
      if (!this.refreshTokens.has(old)) return this.json(res, 400, { error: 'invalid_grant', error_description: 'refresh_token not found' });
      const accessToken = this.newToken('access');
      let refreshToken = old;
      if (this.opts.rotateRefreshTokens) {
        this.refreshTokens.delete(old);
        refreshToken = this.newToken('refresh');
        this.refreshTokens.add(refreshToken);
      }
      this.accessTokens.set(accessToken, refreshToken);
      const reply: Record<string, unknown> = {
        access_token: accessToken, token_type: 'Bearer', user: { id: 42, name: 'Test Student' }, expires_in: this.opts.accessTtlSeconds,
      };
      if (this.opts.rotateRefreshTokens) reply.refresh_token = refreshToken;
      return this.json(res, 200, reply);
    }
    return this.json(res, 400, { error: 'unsupported_grant_type' });
  }

  private revoke(req: IncomingMessage, body: string, res: ServerResponse): void {
    const authorization = req.headers.authorization;
    this.revokeRequests.push({ authorization, body });
    if (this.revokeStatus !== null) return this.json(res, this.revokeStatus, {});
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const refresh = this.accessTokens.get(token);
    if (refresh === undefined) return this.json(res, 401, { errors: [{ message: 'Invalid access token.' }] });
    // Canvas deletes the AccessToken row, which also holds the refresh token.
    for (const [access, r] of this.accessTokens) if (r === refresh) this.accessTokens.delete(access);
    this.refreshTokens.delete(refresh);
    return this.json(res, 200, {});
  }
}

/**
 * Plays the user's browser: GET the authorize URL (the mock "approves" and redirects), then
 * follow the redirect to TaskPet's loopback receiver. Returns the receiver's response.
 */
export async function simulateBrowser(authorizeUrl: string): Promise<{ status: number; html: string; location: string }> {
  const consent = await fetch(authorizeUrl, { redirect: 'manual' });
  await consent.text();
  const location = consent.headers.get('location');
  if (!location) throw new Error(`authorize step answered ${consent.status} without a redirect`);
  const callback = await fetch(location);
  return { status: callback.status, html: await callback.text(), location };
}
