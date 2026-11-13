/**
 * Loopback mock of the Canvas LMS REST API for tests. Listens on 127.0.0.1 with an ephemeral
 * port; never contacts any real Canvas instance. Every request is recorded and checked:
 * GET only, `Authorization: Bearer <known test token>`, a TaskPet User-Agent, and no token in
 * the URL. Violations are collected in `violations` for tests to assert empty.
 */
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Fake credentials for tests only. Not real secrets. */
export const FAKE_CANVAS_TOKEN = 'fake-canvas-token-for-tests-0001';
export const FAKE_CANVAS_TOKEN_2 = 'fake-canvas-token-for-tests-0002';

export interface RecordedRequest {
  method: string;
  /** Path + query, e.g. /api/v1/planner/items?per_page=100 */
  url: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
}

export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Strings are sent verbatim; anything else as JSON. */
  body?: unknown;
}

/** Return a response, or 'hang' to never answer (for timeout tests). */
export type MockHandler = (request: RecordedRequest, server: MockCanvas) => MockResponse | 'hang' | Promise<MockResponse | 'hang'>;

export interface MockCanvas {
  readonly origin: string;
  readonly requests: RecordedRequest[];
  readonly violations: string[];
  handler: MockHandler;
  close(): Promise<void>;
}

export interface MockCanvasOptions {
  /** Tokens accepted as valid Bearer values (and forbidden from appearing in URLs). */
  tokens?: string[];
  handler?: MockHandler;
}

export async function startMockCanvas(options: MockCanvasOptions = {}): Promise<MockCanvas> {
  const tokens = options.tokens ?? [FAKE_CANVAS_TOKEN, FAKE_CANVAS_TOKEN_2];
  const hanging = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    const parsed = new URL(url, 'http://127.0.0.1');
    const recorded: RecordedRequest = {
      method: req.method ?? '', url, path: parsed.pathname, query: parsed.searchParams, headers: req.headers,
    };
    mock.requests.push(recorded);

    if (recorded.method !== 'GET') mock.violations.push(`non-GET request: ${recorded.method} ${parsed.pathname}`);
    const auth = req.headers.authorization ?? '';
    if (!tokens.some(token => auth === `Bearer ${token}`)) mock.violations.push(`missing/unknown Bearer auth on ${parsed.pathname}`);
    if (!/^TaskPet\/\S+ \(.+\)$/.test(req.headers['user-agent'] ?? '')) mock.violations.push(`bad User-Agent on ${parsed.pathname}`);
    for (const token of tokens) {
      if (decodeURIComponent(url).includes(token)) mock.violations.push(`token in URL: ${parsed.pathname}`);
    }
    if (/access_token/i.test(url)) mock.violations.push(`access_token query parameter on ${parsed.pathname}`);

    Promise.resolve(mock.handler(recorded, mock)).then(result => {
      if (result === 'hang') { hanging.add(res); return; }
      const status = result.status ?? 200;
      const body = result.body === undefined ? '' : typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...result.headers });
      res.end(body);
    }, error => {
      mock.violations.push(`handler threw: ${String(error)}`);
      res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const mock: MockCanvas = {
    origin: `http://127.0.0.1:${port}`,
    requests: [],
    violations: [],
    handler: options.handler ?? (() => ({ status: 404, body: { errors: [{ message: 'not found' }] } })),
    close: () => new Promise<void>(resolve => {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
  return mock;
}

/** RFC 8288 Link header value for Canvas-style pagination. */
export function linkHeader(links: Partial<Record<'current' | 'next' | 'prev' | 'first' | 'last', string>>): string {
  return Object.entries(links).map(([rel, href]) => `<${href}>; rel="${rel}"`).join(',');
}
