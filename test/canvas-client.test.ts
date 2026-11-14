// Canvas LMS (coursework) HTTP client tests. Loopback mock server only; never a real Canvas.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CanvasApiError, CanvasClient, parseNextLink, parseRetryAfter, type CanvasClientOptions } from '../src/canvas/client.ts';
import { PersonalTokenAuth } from '../src/canvas/personal-token.ts';
import type { CanvasAuth } from '../src/canvas/auth.ts';
import { ProviderAuthError } from '../src/tasks/types.ts';
import {
  FAKE_CANVAS_TOKEN, FAKE_CANVAS_TOKEN_2, linkHeader, startMockCanvas, type MockCanvas,
} from './helpers/mock-canvas-server.ts';

const servers: MockCanvas[] = [];
async function server(handler?: MockCanvas['handler']): Promise<MockCanvas> {
  const mock = await startMockCanvas(handler ? { handler } : {});
  servers.push(mock);
  return mock;
}
afterEach(async () => {
  for (const mock of servers.splice(0)) {
    assert.deepEqual(mock.violations, [], 'every request must be GET with Bearer auth and UA, token never in URL');
    await mock.close();
  }
});

const personal = (token: string | null = FAKE_CANVAS_TOKEN) => new PersonalTokenAuth({ loadToken: () => token });

function client(mock: { origin: string }, overrides: Partial<CanvasClientOptions> = {}) {
  const sleeps: number[] = [];
  const instance = new CanvasClient({
    baseUrl: mock.origin, auth: personal(), maxRetries: 2, random: () => 1, timeoutMs: 2000,
    sleep: async ms => { sleeps.push(ms); },
    ...overrides,
  });
  return { client: instance, sleeps };
}

function assertNoSecrets(error: unknown) {
  const text = `${String(error)} ${error instanceof Error ? error.stack ?? '' : ''}`;
  assert.ok(!text.includes(FAKE_CANVAS_TOKEN) && !text.includes(FAKE_CANVAS_TOKEN_2), 'error must not contain a token');
  assert.ok(!/Bearer\s+fake/i.test(text), 'error must not contain the Authorization header');
}

test('parseNextLink handles Canvas Link headers robustly', () => {
  const header = '<https://canvas.example.edu/api/v1/x?page=1>; rel="current",<https://canvas.example.edu/api/v1/x?page=bookmark:abc>; rel="next",<https://canvas.example.edu/api/v1/x?page=1>; rel="first"';
  assert.equal(parseNextLink(header), 'https://canvas.example.edu/api/v1/x?page=bookmark:abc');
  assert.equal(parseNextLink('<https://a.example/x?p=2>;rel=next'), 'https://a.example/x?p=2');
  assert.equal(parseNextLink('<https://a.example/x?p=2>; title="a, b"; REL="prev next"'), 'https://a.example/x?p=2');
  assert.equal(parseNextLink('<https://a.example/x?p=1>; rel="first", <https://a.example/x?p=9>; rel="last"'), null);
  assert.equal(parseNextLink(null), null);
  assert.equal(parseNextLink('garbage'), null);
});

test('parseRetryAfter accepts seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('7'), 7000);
  assert.equal(parseRetryAfter('1.5'), 1500);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4000), 6000);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(null), null);
});

test('follows Link rel="next" across 3 pages with opaque URLs, sending Bearer auth and User-Agent', async () => {
  const mock = await server(req => {
    const page = req.query.get('page') ?? 'first';
    const next = { first: 'bookmark:Zm9vMg', 'bookmark:Zm9vMg': 'bookmark:YmFyMw' } as Record<string, string>;
    const headers: Record<string, string> = {};
    if (next[page]) headers.Link = linkHeader({ current: `${mock.origin}${req.url}`, next: `${mock.origin}/api/v1/things?page=${next[page]}&per_page=2` });
    return { headers, body: [{ page }, { page }] };
  });
  const { client: c } = client(mock);
  const result = await c.getPaginated<{ page: string }>('/api/v1/things', { per_page: 2, 'include[]': ['a', 'b'] });
  assert.equal(result.pages, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.items.map(i => i.page), ['first', 'first', 'bookmark:Zm9vMg', 'bookmark:Zm9vMg', 'bookmark:YmFyMw', 'bookmark:YmFyMw']);
  assert.equal(mock.requests.length, 3);
  assert.equal(mock.requests[0]!.url, '/api/v1/things?per_page=2&include%5B%5D=a&include%5B%5D=b');
  for (const req of mock.requests) {
    assert.equal(req.headers.authorization, `Bearer ${FAKE_CANVAS_TOKEN}`);
    assert.equal(req.headers['user-agent'], 'TaskPet/0.1 (local desktop app)');
    assert.equal(req.headers.accept, 'application/json');
  }
});

test('stops at maxPages and reports truncation', async () => {
  const mock = await server(req => {
    const n = Number(req.query.get('page') ?? '1');
    return { headers: { Link: linkHeader({ next: `${mock.origin}/api/v1/things?page=${n + 1}` }) }, body: [n] };
  });
  const result = await client(mock, { maxPages: 4 }).client.getPaginated('/api/v1/things');
  assert.deepEqual(result.items, [1, 2, 3, 4]);
  assert.equal(result.truncated, true);
  assert.equal(mock.requests.length, 4);
});

test('a next link to a different origin is refused and that server receives nothing', async () => {
  const other = await server(() => ({ body: [] }));
  const mock = await server(() => ({
    headers: { Link: linkHeader({ next: `${other.origin}/api/v1/things?page=2` }) },
    body: [1],
  }));
  await assert.rejects(client(mock).client.getPaginated('/api/v1/things'), (error: unknown) => {
    assert.ok(error instanceof CanvasApiError);
    assert.equal(error.kind, 'pagination');
    assert.match(error.message, /different address/);
    assertNoSecrets(error);
    return true;
  });
  assert.equal(other.requests.length, 0);
  assert.equal(mock.requests.length, 1);
});

test('a repeating next link is refused instead of looping', async () => {
  const mock = await server(req => ({ headers: { Link: linkHeader({ next: `${mock.origin}${req.url}` }) }, body: [] }));
  await assert.rejects(client(mock).client.getPaginated('/api/v1/things'), /repeats an earlier page/);
  assert.equal(mock.requests.length, 1);
});

test('redirects are refused, not followed, so the token cannot be carried elsewhere', async () => {
  const other = await server(() => ({ body: [] }));
  const mock = await server(() => ({ status: 302, headers: { Location: `${other.origin}/login` } }));
  await assert.rejects(client(mock).client.getJson('/api/v1/users/self'), (error: unknown) => {
    assert.ok(error instanceof CanvasApiError);
    assert.equal(error.kind, 'redirect');
    assertNoSecrets(error);
    return true;
  });
  assert.equal(other.requests.length, 0);
  assert.equal(mock.requests.length, 1, 'redirects are not retried');
});

test('401 with a personal token throws ProviderAuthError without retrying', async () => {
  const mock = await server(() => ({ status: 401, body: { errors: [{ message: 'Invalid access token.' }] } }));
  await assert.rejects(client(mock).client.getJson('/api/v1/users/self'), (error: unknown) => {
    assert.ok(error instanceof ProviderAuthError);
    assert.match(error.message, /expired or been revoked/);
    assert.match(error.message, /Lil Deadline Settings/);
    assertNoSecrets(error);
    return true;
  });
  assert.equal(mock.requests.length, 1);
});

class RefreshingAuth implements CanvasAuth {
  readonly kind = 'oauth2' as const;
  token = FAKE_CANVAS_TOKEN;
  unauthorizedCalls = 0;
  private readonly canRefresh: boolean;
  constructor(canRefresh: boolean) { this.canRefresh = canRefresh; }
  async accessToken() { return this.token; }
  async handleUnauthorized() {
    this.unauthorizedCalls++;
    if (!this.canRefresh) return false;
    this.token = FAKE_CANVAS_TOKEN_2;
    return true;
  }
}

test('401 then a successful retry with the refreshed token', async () => {
  const mock = await server(req => req.headers.authorization === `Bearer ${FAKE_CANVAS_TOKEN_2}`
    ? { body: { id: 1 } } : { status: 401, body: { errors: [{ message: 'Invalid access token.' }] } });
  const auth = new RefreshingAuth(true);
  const result = await client(mock, { auth }).client.getJson('/api/v1/users/self');
  assert.deepEqual(result, { id: 1 });
  assert.equal(auth.unauthorizedCalls, 1);
  assert.deepEqual(mock.requests.map(r => r.headers.authorization), [`Bearer ${FAKE_CANVAS_TOKEN}`, `Bearer ${FAKE_CANVAS_TOKEN_2}`]);
});

test('re-authentication is attempted only once per request', async () => {
  const mock = await server(() => ({ status: 401 }));
  const auth = new RefreshingAuth(true);
  await assert.rejects(client(mock, { auth }).client.getJson('/api/v1/users/self'), (error: unknown) => {
    assert.ok(error instanceof ProviderAuthError);
    assert.match(error.message, /sign in to Canvas again/);
    return true;
  });
  assert.equal(auth.unauthorizedCalls, 1);
  assert.equal(mock.requests.length, 2);
});

test('missing personal token fails before any request', async () => {
  const mock = await server(() => ({ body: {} }));
  await assert.rejects(client(mock, { auth: personal(null) }).client.getJson('/api/v1/users/self'), ProviderAuthError);
  assert.equal(mock.requests.length, 0);
});

test('429 honours Retry-After, then succeeds', async () => {
  let calls = 0;
  const mock = await server(() => (++calls === 1 ? { status: 429, headers: { 'Retry-After': '7' }, body: '429 Rate Limit Exceeded' } : { body: [1] }));
  const { client: c, sleeps } = client(mock);
  assert.deepEqual(await c.getJson('/api/v1/planner/items'), [1]);
  assert.deepEqual(sleeps, [7000]);
  assert.equal(mock.requests.length, 2);
});

test('legacy 403 "Rate Limit Exceeded" is retried with backoff; other 403s are not', async () => {
  let calls = 0;
  const mock = await server(req => {
    if (req.path === '/api/v1/forbidden') return { status: 403, body: { errors: [{ message: 'user not authorized to perform that action' }] } };
    return ++calls === 1 ? { status: 403, body: '403 Forbidden (Rate Limit Exceeded)' } : { body: { ok: true } };
  });
  const { client: c, sleeps } = client(mock, { backoffInitialMs: 1000 });
  assert.deepEqual(await c.getJson('/api/v1/users/self'), { ok: true });
  assert.deepEqual(sleeps, [1000]);
  await assert.rejects(c.getJson('/api/v1/forbidden'), (error: unknown) => {
    assert.ok(error instanceof CanvasApiError);
    assert.equal(error.status, 403);
    assert.match(error.message, /user not authorized/);
    return true;
  });
  assert.equal(mock.requests.length, 3);
});

test('rate limiting with an excessive Retry-After fails instead of hanging', async () => {
  const mock = await server(() => ({ status: 429, headers: { 'Retry-After': '3600' } }));
  await assert.rejects(client(mock).client.getJson('/api/v1/x'), (error: unknown) =>
    error instanceof CanvasApiError && error.kind === 'rate-limit' && /3600 s/.test(error.message));
  assert.equal(mock.requests.length, 1);
});

test('5xx is retried with bounded exponential backoff and jitter', async () => {
  const mock = await server(() => ({ status: 503, body: '<html>Service Unavailable</html>' }));
  const { client: c, sleeps } = client(mock, { maxRetries: 3, backoffInitialMs: 1000, random: () => 0 });
  await assert.rejects(c.getJson('/api/v1/x'), (error: unknown) => {
    assert.ok(error instanceof CanvasApiError);
    assert.equal(error.kind, 'http');
    assert.equal(error.status, 503);
    assert.ok(!error.message.includes('<html>'), 'HTML bodies are not echoed');
    return true;
  });
  assert.equal(mock.requests.length, 4);
  assert.deepEqual(sleeps, [500, 1000, 2000]);
});

test('5xx then success recovers', async () => {
  let calls = 0;
  const mock = await server(() => (++calls < 3 ? { status: 500 } : { body: [] }));
  const { client: c, sleeps } = client(mock, { maxRetries: 3 });
  assert.deepEqual(await c.getJson('/api/v1/x'), []);
  assert.equal(sleeps.length, 2);
});

test('other 4xx fail immediately with a short sanitized snippet', async () => {
  const long = `Not found ${'x'.repeat(500)}\u0007`;
  const mock = await server(() => ({ status: 404, body: { errors: [{ message: long }] } }));
  await assert.rejects(client(mock).client.getJson('/api/v1/x'), (error: unknown) => {
    assert.ok(error instanceof CanvasApiError);
    assert.equal(error.status, 404);
    assert.ok(error.message.length < 300);
    assert.ok(!error.message.includes('\u0007'));
    return true;
  });
  assert.equal(mock.requests.length, 1);
});

test('a hung response times out and is retried a bounded number of times', async () => {
  const mock = await server(() => 'hang');
  const { client: c, sleeps } = client(mock, { timeoutMs: 150, maxRetries: 1 });
  await assert.rejects(c.getJson('/api/v1/x'), (error: unknown) => error instanceof CanvasApiError && error.kind === 'timeout');
  assert.equal(mock.requests.length, 2);
  assert.equal(sleeps.length, 1);
});

test('the caller signal cancels an in-flight request', async () => {
  const mock = await server(() => 'hang');
  const controller = new AbortController();
  const pending = client(mock, { timeoutMs: 10_000 }).client.getJson('/api/v1/x', undefined, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(mock.requests.length, 1, 'a cancelled request is not retried');
});

test('network failures are retried, then reported without secrets', async () => {
  const mock = await server();
  const origin = mock.origin;
  await mock.close();
  servers.splice(servers.indexOf(mock), 1);
  const { client: c, sleeps } = client({ origin }, { maxRetries: 2 });
  await assert.rejects(c.getJson('/api/v1/x'), (error: unknown) => {
    assert.ok(error instanceof CanvasApiError);
    assert.equal(error.kind, 'network');
    assertNoSecrets(error);
    return true;
  });
  assert.equal(sleeps.length, 2);
});

test('malformed JSON is an error and is not retried', async () => {
  const mock = await server(() => ({ body: '[{"broken": ' }));
  await assert.rejects(client(mock).client.getJson('/api/v1/x'), (error: unknown) => error instanceof CanvasApiError && error.kind === 'json');
  assert.equal(mock.requests.length, 1);
});

test('a non-array page from a list endpoint is rejected', async () => {
  const mock = await server(() => ({ body: { errors: [] } }));
  await assert.rejects(client(mock).client.getPaginated('/api/v1/x'), /expected a list/);
});

test('requests are sequential: never more than one in flight', async () => {
  let inFlight = 0, maxInFlight = 0;
  const mock = await server(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 20));
    inFlight--;
    return { body: [] };
  });
  const { client: c } = client(mock);
  await Promise.all([c.getJson('/api/v1/a'), c.getJson('/api/v1/b'), c.getPaginated('/api/v1/c')]);
  assert.equal(mock.requests.length, 3);
  assert.equal(maxInFlight, 1);
});

test('paths must stay on the configured origin', async () => {
  const c = new CanvasClient({ baseUrl: 'https://canvas.example.edu', auth: personal(), fetch: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(c.getJson('//evil.example/api'), /single "\/"/);
  await assert.rejects(c.getJson('https://evil.example/api'), /single "\/"/);
});
