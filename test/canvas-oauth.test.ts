import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SCOPES, redirectUriFor, resolveOAuthConfig, loadOAuthConfig, type CanvasOAuthConfig,
} from '../src/canvas/oauth/config.ts';
import { CanvasSignInError, startCanvasSignIn } from '../src/canvas/oauth/flow.ts';
import { PortInUseError } from '../src/canvas/oauth/loopback-server.ts';
import {
  OAuth2CanvasAuth, SIGN_IN_EXPIRED_MESSAGE, describeSignIn,
} from '../src/canvas/oauth/oauth-auth.ts';
import { MemoryTokenStore, appStorageTokenStore } from '../src/canvas/oauth/token-store.ts';
import { browserCommand, isOpenableUrl, openInBrowser, type SpawnLike } from '../src/canvas/oauth/browser.ts';
import { constantTimeEqual, createPkcePair, pkceChallenge } from '../src/canvas/oauth/pkce.ts';
import { ProviderAuthError } from '../src/tasks/types.ts';
import { AppStorage } from '../src/host/storage.ts';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, MockCanvasOAuth, simulateBrowser } from './helpers/mock-canvas-oauth.ts';

const T0 = Date.parse('2026-11-13T12:00:00.000Z');

async function startMock(t: { after(fn: () => unknown): void }, opts?: ConstructorParameters<typeof MockCanvasOAuth>[0]) {
  const mock = await new MockCanvasOAuth(opts).start();
  t.after(() => mock.stop());
  return mock;
}

function configFor(mock: MockCanvasOAuth, over: Partial<CanvasOAuthConfig> = {}): CanvasOAuthConfig {
  const resolved = resolveOAuthConfig({ baseUrl: mock.origin, clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, redirectPort: 0 });
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.problems.join('; '));
  return { ...resolved.config, ...over };
}

/** No credential-like value may ever appear in user-facing text. */
function assertClean(text: string, extra: readonly string[] = []): void {
  for (const secret of [FAKE_CLIENT_SECRET, ...extra]) {
    assert.ok(!text.includes(secret), `leaked a secret into: ${text.slice(0, 120)}`);
  }
  assert.ok(!/mock-(access|refresh|code)-/.test(text), `leaked a token/code into: ${text.slice(0, 120)}`);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { return error as Error; }
  assert.fail('expected a rejection');
}

const refused = async (url: string) => {
  await assert.rejects(fetch(url), 'loopback receiver must be closed');
};

// --- sign-in flow ------------------------------------------------------------------

test('sign-in: authorize URL, PKCE, code exchange, tokens saved, static page, server closed', async t => {
  const mock = await startMock(t);
  const store = new MemoryTokenStore();
  const session = await startCanvasSignIn({ config: configFor(mock), store, now: () => T0 });

  assert.equal(session.listenAddress, '127.0.0.1');
  assert.match(session.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
  const auth = new URL(session.authorizeUrl);
  assert.equal(auth.origin, mock.origin);
  assert.equal(auth.pathname, '/login/oauth2/auth');
  assert.equal(auth.searchParams.get('client_id'), FAKE_CLIENT_ID);
  assert.equal(auth.searchParams.get('response_type'), 'code');
  assert.equal(auth.searchParams.get('redirect_uri'), session.redirectUri);
  assert.equal(auth.searchParams.get('scope'), DEFAULT_SCOPES.join(' '));
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.ok((auth.searchParams.get('state') ?? '').length >= 43, 'state has >= 256 bits');
  assertClean(session.authorizeUrl);
  assert.ok(!session.authorizeUrl.includes('client_secret'));

  const browser = await simulateBrowser(session.authorizeUrl);
  const result = await session.result;
  assert.equal(browser.status, 200);
  assert.match(browser.html, /Signed in/);
  const code = new URL(browser.location).searchParams.get('code')!;
  const state = auth.searchParams.get('state')!;
  const tokens = store.load()!;
  assertClean(browser.html, [code, state, tokens.accessToken, tokens.refreshToken!]);

  assert.ok(mock.accessTokens.has(tokens.accessToken));
  assert.ok(tokens.refreshToken && mock.refreshTokens.has(tokens.refreshToken));
  assert.equal(tokens.expiresAt, new Date(T0 + 3600_000).toISOString());
  assert.equal(tokens.userId, '42');
  assert.deepEqual(result, { userId: '42', expiresAt: tokens.expiresAt, hasRefreshToken: true });

  const exchange = mock.tokenRequests[0]!;
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  assert.equal(exchange.get('client_secret'), FAKE_CLIENT_SECRET);
  assert.equal(exchange.get('redirect_uri'), session.redirectUri);
  assert.equal(pkceChallenge(exchange.get('code_verifier')!), auth.searchParams.get('code_challenge'), 'mock verified PKCE');

  await refused(`${session.redirectUri}?code=again&state=${state}`);
});

test('sign-in: wrong state, missing state, wrong path and foreign Host are rejected without ending the flow', async t => {
  const mock = await startMock(t);
  const store = new MemoryTokenStore();
  const session = await startCanvasSignIn({ config: configFor(mock), store });
  const base = new URL(session.redirectUri);

  const wrong = await fetch(`${session.redirectUri}?code=forged-code&state=wrong-state`);
  assert.equal(wrong.status, 400);
  assert.ok(!(await wrong.text()).includes('forged-code'));
  assert.equal((await fetch(`${session.redirectUri}?code=forged-code`)).status, 400);
  assert.equal((await fetch(`${base.origin}/other?code=x&state=y`)).status, 404);
  const realState = new URL(session.authorizeUrl).searchParams.get('state')!;
  const foreignHost = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: base.port, path: `/oauth/callback?code=x&state=${realState}`, headers: { Host: 'evil.example:80' } },
      res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(foreignHost, 404, 'DNS-rebinding guard');
  assert.equal(mock.tokenRequests.length, 0, 'no exchange for rejected requests');
  assert.equal(store.load(), null);

  const browser = await simulateBrowser(session.authorizeUrl);
  assert.equal(browser.status, 200);
  await session.result;
  assert.ok(store.load());
});

test('sign-in: access_denied gives a friendly error and saves nothing', async t => {
  const mock = await startMock(t);
  mock.authorizeError = 'access_denied';
  const store = new MemoryTokenStore();
  const session = await startCanvasSignIn({ config: configFor(mock), store });
  const browser = await simulateBrowser(session.authorizeUrl);
  const error = await rejection(session.result);
  assert.ok(error instanceof CanvasSignInError);
  assert.equal(error.code, 'access_denied');
  assert.match(error.message, /chose not to authorize/);
  assert.match(browser.html, /did not authorize/);
  assert.equal(mock.tokenRequests.length, 0);
  assert.equal(store.load(), null);
});

test('sign-in: other OAuth errors (invalid_scope) explain what to ask the admins', async t => {
  const mock = await startMock(t);
  mock.authorizeError = 'invalid_scope';
  const session = await startCanvasSignIn({ config: configFor(mock), store: new MemoryTokenStore() });
  const browser = await simulateBrowser(session.authorizeUrl);
  assert.equal(browser.status, 400);
  const error = await rejection(session.result) as CanvasSignInError;
  assert.equal(error.code, 'oauth_error');
  assert.match(error.message, /scopes/);
});

test('sign-in: times out, closes the receiver and saves nothing', async t => {
  const mock = await startMock(t);
  const store = new MemoryTokenStore();
  const session = await startCanvasSignIn({ config: configFor(mock), store, timeoutMs: 50 });
  const error = await rejection(session.result) as CanvasSignInError;
  assert.equal(error.code, 'timeout');
  await new Promise(resolve => setTimeout(resolve, 20));
  await refused(session.redirectUri);
  assert.equal(store.load(), null);
});

test('sign-in: cancellation via AbortSignal and cancel()', async t => {
  const mock = await startMock(t);
  const controller = new AbortController();
  const a = await startCanvasSignIn({ config: configFor(mock), store: new MemoryTokenStore(), signal: controller.signal });
  controller.abort();
  assert.equal((await rejection(a.result) as CanvasSignInError).code, 'cancelled');
  const b = await startCanvasSignIn({ config: configFor(mock), store: new MemoryTokenStore() });
  b.cancel();
  assert.equal((await rejection(b.result) as CanvasSignInError).code, 'cancelled');
  await refused(b.redirectUri);
});

test('sign-in: token endpoint 400 fails cleanly; secrets echoed by the server never surface', async t => {
  const mock = await startMock(t);
  mock.tokenFailure = { status: 400, body: { error: 'invalid_grant', error_description: `bad ${FAKE_CLIENT_SECRET}` } };
  const store = new MemoryTokenStore();
  const session = await startCanvasSignIn({ config: configFor(mock), store });
  const browser = await simulateBrowser(session.authorizeUrl);
  const error = await rejection(session.result) as CanvasSignInError;
  assert.equal(error.code, 'token_error');
  assert.match(error.message, /invalid_grant/);
  const code = new URL(browser.location).searchParams.get('code')!;
  const verifier = mock.tokenRequests[0]!.get('code_verifier')!;
  assertClean(error.message, [code, verifier]);
  assertClean(browser.html, [code, verifier]);
  assert.equal(browser.status, 502);
  assert.equal(store.load(), null);
});

test('sign-in: PKCE can be disabled; a PKCE-requiring server then refuses the exchange', async t => {
  const plain = await startMock(t);
  const s1 = await startCanvasSignIn({ config: configFor(plain, { usePkce: false }), store: new MemoryTokenStore() });
  assert.equal(new URL(s1.authorizeUrl).searchParams.get('code_challenge'), null);
  await simulateBrowser(s1.authorizeUrl);
  await s1.result;
  assert.equal(plain.tokenRequests[0]!.get('code_verifier'), null);

  const strict = await startMock(t, { requirePkce: true });
  const s2 = await startCanvasSignIn({ config: configFor(strict, { usePkce: false }), store: new MemoryTokenStore() });
  await simulateBrowser(s2.authorizeUrl);
  assert.equal((await rejection(s2.result) as CanvasSignInError).code, 'token_error');
});

test('sign-in: public client (no secret) with PKCE never sends client_secret', async t => {
  const mock = await startMock(t, { clientSecret: null });
  const store = new MemoryTokenStore();
  const session = await startCanvasSignIn({ config: configFor(mock, { clientSecret: null }), store });
  await simulateBrowser(session.authorizeUrl);
  await session.result;
  assert.equal(mock.tokenRequests[0]!.has('client_secret'), false);
  assert.ok(store.load());
});

test('sign-in: fixed port already in use gives a clear error', async t => {
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => blocker.close(() => resolve())));
  const port = (blocker.address() as AddressInfo).port;
  const mock = await startMock(t);
  const error = await rejection(startCanvasSignIn({ config: configFor(mock, { redirectPort: port }), store: new MemoryTokenStore() }));
  assert.ok(error instanceof PortInUseError);
  assert.match(error.message, new RegExp(String(port)));
});

// --- OAuth2CanvasAuth ------------------------------------------------------------------

function signedIn(mock: MockCanvasOAuth, expiresAt: string | null) {
  const { accessToken, refreshToken } = mock.issueTokens();
  return new MemoryTokenStore({ accessToken, refreshToken, expiresAt, userId: '42' });
}

test('auth: valid token is returned without refreshing', async t => {
  const mock = await startMock(t);
  const store = signedIn(mock, new Date(T0 + 30 * 60_000).toISOString());
  const auth = new OAuth2CanvasAuth({ config: configFor(mock), store, now: () => T0 });
  assert.equal(auth.kind, 'oauth2');
  assert.equal(await auth.accessToken(), store.load()!.accessToken);
  assert.equal(mock.refreshCount, 0);
});

test('auth: refreshes within 60 s of expiry and keeps the old refresh token when omitted', async t => {
  const mock = await startMock(t);
  const store = signedIn(mock, new Date(T0 + 30_000).toISOString());
  const before = store.load()!;
  const auth = new OAuth2CanvasAuth({ config: configFor(mock), store, now: () => T0 });
  const token = await auth.accessToken();
  assert.notEqual(token, before.accessToken);
  assert.equal(mock.refreshCount, 1);
  const after = store.load()!;
  assert.equal(after.accessToken, token);
  assert.equal(after.refreshToken, before.refreshToken, 'Canvas omits refresh_token on refresh');
  assert.equal(after.expiresAt, new Date(T0 + 3600_000).toISOString());
  const req = mock.tokenRequests[0]!;
  assert.equal(req.get('grant_type'), 'refresh_token');
  assert.equal(req.get('client_secret'), FAKE_CLIENT_SECRET);
});

test('auth: a rotated refresh token is saved', async t => {
  const mock = await startMock(t, { rotateRefreshTokens: true });
  const store = signedIn(mock, new Date(T0 - 1000).toISOString());
  const old = store.load()!.refreshToken;
  await new OAuth2CanvasAuth({ config: configFor(mock), store, now: () => T0 }).accessToken();
  assert.notEqual(store.load()!.refreshToken, old);
  assert.ok(mock.refreshTokens.has(store.load()!.refreshToken!));
});

test('auth: concurrent accessToken() calls share ONE refresh', async t => {
  const mock = await startMock(t, { refreshDelayMs: 80 });
  const store = signedIn(mock, new Date(T0 - 1000).toISOString());
  const auth = new OAuth2CanvasAuth({ config: configFor(mock), store, now: () => T0 });
  const tokens = await Promise.all(Array.from({ length: 6 }, () => auth.accessToken()));
  assert.equal(mock.refreshCount, 1);
  assert.equal(new Set(tokens).size, 1);
  assert.equal(tokens[0], store.load()!.accessToken);
});

test('auth: invalid_grant clears tokens and throws ProviderAuthError', async t => {
  const mock = await startMock(t);
  const store = new MemoryTokenStore({ accessToken: 'stale-access', refreshToken: 'revoked-refresh', expiresAt: new Date(T0 - 1).toISOString(), userId: '42' });
  const auth = new OAuth2CanvasAuth({ config: configFor(mock), store, now: () => T0 });
  const error = await rejection(auth.accessToken());
  assert.ok(error instanceof ProviderAuthError);
  assert.equal(error.message, SIGN_IN_EXPIRED_MESSAGE);
  assert.equal(store.load(), null);
  assert.ok(!error.message.includes('revoked-refresh'));
  // Afterwards: not signed in.
  assert.ok(await rejection(auth.accessToken()) instanceof ProviderAuthError);
});

test('auth: rejected developer key (invalid_client) is an auth error without leaking the secret', async t => {
  const mock = await startMock(t);
  const store = signedIn(mock, new Date(T0 - 1).toISOString());
  const auth = new OAuth2CanvasAuth({ config: configFor(mock, { clientSecret: 'wrong-secret-value-123' }), store, now: () => T0 });
  const error = await rejection(auth.accessToken());
  assert.ok(error instanceof ProviderAuthError);
  assert.match(error.message, /developer key/);
  assertClean(error.message, ['wrong-secret-value-123']);
  assert.equal(store.load(), null);
});

test('auth: transient token-endpoint failures keep tokens and are not auth errors', async t => {
  const mock = await startMock(t);
  mock.tokenFailure = { status: 503, body: { error: 'temporarily_unavailable' } };
  const store = signedIn(mock, new Date(T0 - 1).toISOString());
  const before = store.load();
  const auth = new OAuth2CanvasAuth({ config: configFor(mock), store, now: () => T0 });
  const error = await rejection(auth.accessToken());
  assert.ok(!(error instanceof ProviderAuthError));
  assert.match(error.message, /HTTP 503/);
  assertClean(error.message);
  assert.deepEqual(store.load(), before);
  // Unreachable Canvas: also transient.
  await mock.stop();
  const offline = await rejection(auth.accessToken());
  assert.ok(!(offline instanceof ProviderAuthError));
  assert.match(offline.message, /could not reach/);
  assert.deepEqual(store.load(), before);
});

test('auth: not signed in / expired without refresh token', async t => {
  const mock = await startMock(t);
  const none = new OAuth2CanvasAuth({ config: configFor(mock), store: new MemoryTokenStore(), now: () => T0 });
  assert.ok(await rejection(none.accessToken()) instanceof ProviderAuthError);
  assert.equal(await none.handleUnauthorized(), false);

  const store = new MemoryTokenStore({ accessToken: 'a-token-1', refreshToken: null, expiresAt: new Date(T0 - 1).toISOString(), userId: null });
  const auth = new OAuth2CanvasAuth({ config: configFor(mock), store, now: () => T0 });
  const error = await rejection(auth.accessToken());
  assert.ok(error instanceof ProviderAuthError);
  assert.equal(store.load(), null);
});

test('auth: handleUnauthorized refreshes once; a burst of 401s does not refresh repeatedly', async t => {
  const mock = await startMock(t);
  const store = signedIn(mock, new Date(T0 + 30 * 60_000).toISOString());
  const before = store.load()!.accessToken;
  let now = T0;
  const auth = new OAuth2CanvasAuth({ config: configFor(mock), store, now: () => now });
  assert.equal(await auth.handleUnauthorized(), true);
  assert.notEqual(await auth.accessToken(), before);
  assert.equal(mock.refreshCount, 1);
  assert.equal(await auth.handleUnauthorized(), true, 'just refreshed: retry with the new token');
  assert.equal(mock.refreshCount, 1);
  now += 10_000;
  assert.equal(await auth.handleUnauthorized(), true);
  assert.equal(mock.refreshCount, 2);

  // No refresh token: cannot help, and tokens are kept (a 401 may be a missing scope).
  const noRefresh = new MemoryTokenStore({ accessToken: 'a-token-2', refreshToken: null, expiresAt: null, userId: null });
  const auth2 = new OAuth2CanvasAuth({ config: configFor(mock), store: noRefresh, now: () => T0 });
  assert.equal(await auth2.handleUnauthorized(), false);
  assert.ok(noRefresh.load());
});

test('signOut: revokes with Bearer and clears local tokens', async t => {
  const mock = await startMock(t);
  const store = signedIn(mock, new Date(T0 + 60 * 60_000).toISOString());
  const { accessToken } = store.load()!;
  const auth = new OAuth2CanvasAuth({ config: configFor(mock), store, now: () => T0 });
  const result = await auth.signOut();
  assert.equal(result.revoked, true);
  assert.equal(result.wasSignedIn, true);
  assert.equal(mock.revokeRequests[0]!.authorization, `Bearer ${accessToken}`);
  assert.equal(mock.revokeRequests[0]!.body, '', 'expire_sessions not sent by default');
  assert.equal(mock.accessTokens.has(accessToken), false);
  assert.equal(store.load(), null);
  assert.equal(describeSignIn(store).signedIn, false);
});

test('signOut: clears tokens even when revoke fails or Canvas is unreachable', async t => {
  const mock = await startMock(t);
  mock.revokeStatus = 500;
  const store = signedIn(mock, null);
  const result = await new OAuth2CanvasAuth({ config: configFor(mock), store }).signOut();
  assert.equal(result.revoked, false);
  assert.equal(store.load(), null);

  const store2 = signedIn(mock, null);
  const config = configFor(mock);
  await mock.stop();
  const offline = await new OAuth2CanvasAuth({ config, store: store2 }).signOut();
  assert.equal(offline.revoked, false);
  assert.equal(offline.status, null);
  assert.equal(store2.load(), null);
});

test('signOut: an expired access token is refreshed once so the grant can still be revoked', async t => {
  const mock = await startMock(t);
  const { accessToken, refreshToken } = mock.issueTokens();
  mock.accessTokens.delete(accessToken); // Canvas no longer accepts it
  const store = new MemoryTokenStore({ accessToken, refreshToken, expiresAt: new Date(T0 - 1).toISOString(), userId: '42' });
  const result = await new OAuth2CanvasAuth({ config: configFor(mock), store, now: () => T0 }).signOut();
  assert.equal(result.revoked, true);
  assert.equal(mock.revokeRequests.length, 2);
  assert.equal(mock.refreshTokens.has(refreshToken), false, 'refresh token revoked at Canvas');
  assert.equal(store.load(), null);
});

test('signOut during an in-flight refresh does not resurrect tokens', async t => {
  const mock = await startMock(t, { refreshDelayMs: 80 });
  const store = signedIn(mock, new Date(T0 - 1).toISOString());
  const auth = new OAuth2CanvasAuth({ config: configFor(mock), store, now: () => T0 });
  const pending = auth.accessToken();
  await new Promise(resolve => setTimeout(resolve, 20));
  await auth.signOut();
  assert.ok(await rejection(pending) instanceof ProviderAuthError);
  assert.equal(store.load(), null);
});

// --- config, storage, PKCE, browser ----------------------------------------------------

test('config: default redirect URI, validation messages without secrets', () => {
  assert.equal(redirectUriFor(51735), 'http://127.0.0.1:51735/oauth/callback');
  const ok = resolveOAuthConfig({ baseUrl: 'canvas.example.edu', clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET });
  assert.ok(ok.ok);
  assert.equal(ok.config.origin, 'https://canvas.example.edu');
  assert.equal(ok.config.redirectPort, 51735);
  assert.equal(ok.config.usePkce, true);

  const missing = resolveOAuthConfig({ baseUrl: '', clientId: '', clientSecret: FAKE_CLIENT_SECRET });
  assert.ok(!missing.ok);
  assert.ok(missing.problems.some(p => /developer key/.test(p)));
  const insecure = resolveOAuthConfig({ baseUrl: 'http://canvas.example.edu', clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET });
  assert.ok(!insecure.ok && insecure.problems.some(p => /https/.test(p)));
  const noSecret = resolveOAuthConfig({ baseUrl: 'https://canvas.example.edu', clientId: FAKE_CLIENT_ID, clientSecret: null, usePkce: false });
  assert.ok(!noSecret.ok);
  for (const r of [missing, insecure, noSecret]) if (!r.ok) for (const p of r.problems) assertClean(p);
});

test('storage adapter: tokens round-trip through AppStorage secrets; config loads from settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskpet-oauth-'));
  try {
    const storage = new AppStorage(dir);
    storage.updateSettings(s => { s.canvas.baseUrl = 'https://canvas.example.edu'; s.canvas.oauthClientId = FAKE_CLIENT_ID; });
    storage.saveCanvasOAuthClientSecret(FAKE_CLIENT_SECRET);
    const loaded = loadOAuthConfig(storage);
    assert.ok(loaded.ok);
    assert.equal(loaded.config.clientSecret, FAKE_CLIENT_SECRET);
    const store = appStorageTokenStore(storage);
    store.save({ accessToken: 'fake-access-for-test', refreshToken: 'fake-refresh-for-test', expiresAt: null, userId: '42' });
    assert.equal(new AppStorage(dir).loadCanvasOAuthTokens()!.refreshToken, 'fake-refresh-for-test');
    assert.equal(storage.describeSecrets().canvasSignedIn, true);
    store.save(null);
    assert.equal(storage.loadCanvasOAuthTokens(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pkce + state helpers', () => {
  const pair = createPkcePair();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(pair.challenge, createHash('sha256').update(pair.verifier).digest('base64url'));
  assert.equal(pkceChallenge(pair.verifier), pair.challenge);
  assert.notEqual(createPkcePair().verifier, pair.verifier);
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', 'a'), false);
});

test('browser: argument-array commands, no shell, refuses non-web URLs', async () => {
  const url = 'https://canvas.example.edu/login/oauth2/auth?client_id=1&response_type=code&state=a%26b';
  assert.deepEqual(browserCommand(url, 'win32'), { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] });
  assert.deepEqual(browserCommand(url, 'darwin'), { command: 'open', args: [url] });
  assert.deepEqual(browserCommand(url, 'linux'), { command: 'xdg-open', args: [url] });
  for (const bad of ['file:///C:/Windows/system32/calc.exe', 'javascript:alert(1)', 'https://x.example/a b', 'https://x.example/"&calc', 'https://user:pw@x.example/', 'not a url']) {
    assert.equal(isOpenableUrl(bad), false, bad);
    assert.throws(() => browserCommand(bad, 'win32'));
  }
  const calls: { command: string; args: readonly string[]; shell: unknown }[] = [];
  const fakeSpawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, shell: options.shell });
    return {
      once(event: string, listener: (...a: never[]) => void) { if (event === 'spawn') setImmediate(listener); return this; },
      unref() {},
    } as ReturnType<SpawnLike>;
  };
  assert.equal(await openInBrowser(url, { platform: 'win32', spawn: fakeSpawn }), true);
  assert.deepEqual(calls, [{ command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url], shell: false }]);
  assert.equal(await openInBrowser('file:///etc/passwd', { platform: 'linux', spawn: fakeSpawn }), false);
  assert.equal(calls.length, 1);
});
