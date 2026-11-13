/**
 * One-shot loopback HTTP server that receives the OAuth redirect from the user's browser.
 *
 * - Binds to 127.0.0.1 only (never 0.0.0.0/::), on a fixed port registered with the
 *   institution (exact redirect URI matching) or an ephemeral port in tests.
 * - Accepts exactly one GET to the callback path whose Host header is ours and whose `state`
 *   matches (constant-time). Wrong paths get 404; missing/mismatched state gets 400 without
 *   ending the flow (a stale tab or a forged request must not abort or hijack sign-in);
 *   anything after completion gets 410 until the server closes.
 * - Pages are static: they never contain the code, tokens or state.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CALLBACK_HOST, CALLBACK_PATH } from './config.ts';
import { constantTimeEqual } from './pkce.ts';

export interface CallbackParams {
  code: string | null;
  error: string | null;
  /** The user-facing description is NOT trusted or shown; kept only as a presence flag. */
  hasErrorDescription: boolean;
}

export interface CallbackPage {
  status: number;
  title: string;
  message: string;
}

export interface LoopbackServerOptions {
  /** 0 = ephemeral (tests). */
  port: number;
  expectedState: string;
  /** Called once for the first valid callback; its page is sent to the browser. */
  onCallback(params: CallbackParams): Promise<CallbackPage>;
}

export interface LoopbackServer {
  readonly port: number;
  readonly address: string;
  readonly redirectUri: string;
  close(): Promise<void>;
}

export class PortInUseError extends Error {
  constructor(port: number) {
    super(`Port ${port} on this computer is already in use, so TaskPet cannot receive the sign-in reply. `
      + 'Close any other TaskPet sign-in window (or the program using that port) and try again.');
    this.name = 'PortInUseError';
  }
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export function renderPage(page: Pick<CallbackPage, 'title' | 'message'>): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>TaskPet - ${escapeHtml(page.title)}</title>`
    + '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#222;background:#fafafa}'
    + '@media (prefers-color-scheme:dark){body{color:#eee;background:#1b1b1b}}</style></head><body>'
    + `<h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.message)}</p></body></html>`;
}

function send(res: ServerResponse, page: CallbackPage): Promise<void> {
  const body = renderPage(page);
  res.writeHead(page.status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    Connection: 'close',
  });
  return new Promise(resolve => {
    res.once('finish', resolve);
    res.once('close', resolve);
    res.end(body);
  });
}

const NOT_FOUND: CallbackPage = { status: 404, title: 'Not found', message: 'This address is only used for signing in to Canvas.' };
const BAD_STATE: CallbackPage = {
  status: 400,
  title: 'Sign-in link not recognised',
  message: 'This reply does not match the sign-in TaskPet started. If you are signing in, use the newest Canvas window TaskPet opened, or start sign-in again.',
};
const DONE: CallbackPage = { status: 410, title: 'Already finished', message: 'This sign-in has already finished. You can close this tab.' };

export async function startLoopbackServer(opts: LoopbackServerOptions): Promise<LoopbackServer> {
  let completed = false;
  let port = opts.port;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, { ...NOT_FOUND, status: 405 });
    // DNS-rebinding guard: the browser must be talking to 127.0.0.1:<port> directly.
    if (req.headers.host !== `${CALLBACK_HOST}:${port}`) return send(res, NOT_FOUND);
    let url: URL;
    try { url = new URL(req.url ?? '/', `http://${CALLBACK_HOST}:${port}`); } catch { return send(res, NOT_FOUND); }
    if (url.pathname !== CALLBACK_PATH) return send(res, NOT_FOUND);
    if (completed) return send(res, DONE);
    const state = url.searchParams.get('state');
    if (state === null || !constantTimeEqual(state, opts.expectedState)) return send(res, BAD_STATE);
    completed = true;
    let page: CallbackPage;
    try {
      page = await opts.onCallback({
        code: url.searchParams.get('code'),
        error: url.searchParams.get('error'),
        hasErrorDescription: url.searchParams.has('error_description'),
      });
    } catch {
      page = { status: 500, title: 'Sign-in failed', message: 'Something went wrong. Return to TaskPet and try again.' };
    }
    return send(res, page);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => { try { res.destroy(); } catch { /* ignore */ } });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(error.code === 'EADDRINUSE' ? new PortInUseError(opts.port)
        : new Error(`Could not start the local sign-in receiver on ${CALLBACK_HOST}:${opts.port} (${error.code ?? 'error'}).`));
    };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port: opts.port, host: CALLBACK_HOST, exclusive: true });
  });
  const address = server.address() as AddressInfo;
  port = address.port;

  let closing: Promise<void> | null = null;
  return {
    port,
    address: address.address,
    redirectUri: `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`,
    close() {
      closing ??= new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeIdleConnections();
        // Give an in-progress response a moment to flush, then drop anything left.
        setTimeout(() => server.closeAllConnections(), 250).unref();
      });
      return closing;
    },
  };
}
