import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import type { ViteDevServer } from 'vite';
import { Application, InputError, validateLanAddress } from './application.ts';

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new InputError('Request too large.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}
export function createAppServer(app: Application, options: { dev?: ViteDevServer; root?: string } = {}) {
  const server = createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: 'The local host could not complete this request.' }); else res.destroy(); }); });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  let uploading = false;
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = (server.address() as { port: number }).port;
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowed.has(req.headers.host ?? '')) { json(res, 403, { error: 'Local clients only.' }); return; }
    if ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') { json(res, 403, { error: 'Origin not permitted.' }); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET' && url.pathname === '/api/state') { json(res, 200, app.snapshot()); return; }
      if (req.method === 'GET' && url.pathname === '/api/camera/stream') {
        try { await validateLanAddress(app.storage.loadSettings().device.address); }
        catch { json(res, 503, { error: 'Configure a reachable LAN camera first.' }); return; }
        await app.camera.serve(req, res, app.storage.loadSettings().device.address, app.storage.loadDeviceToken()); return;
      }
      if (req.method !== 'POST' || req.headers['x-lil-deadline'] !== '1') { json(res, 403, { error: 'Expected a local app request.' }); return; }
      try {
        if (url.pathname === '/api/frame') {
          if (uploading) { json(res, 429, { error: 'A frame is already arriving.' }); return; }
          if (req.headers['content-type'] !== 'application/octet-stream') throw new InputError('Expected binary pixels.');
          uploading = true;
          try { const bytes = await readBody(req, 307200); const accepted = app.acceptFrame(String(req.headers['x-renderer-id'] ?? ''), bytes); json(res, accepted ? 200 : 409, { accepted }); }
          finally { uploading = false; }
          return;
        }
        if (req.headers['content-type'] !== 'application/json') throw new InputError('Expected JSON.');
        let body: unknown;
        try { body = JSON.parse((await readBody(req, 16_384)).toString('utf8')); }
        catch { throw new InputError('Invalid request.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Expected an object.');
        await app.action(url.pathname, body as Record<string, unknown>);
        json(res, 200, app.snapshot());
      } catch (error) { json(res, error instanceof InputError ? 400 : 500, { error: error instanceof InputError ? error.message : 'Could not save this change. Check the local data directory and retry.' }); }
      return;
    }
    if (options.dev) { options.dev.middlewares(req, res); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const root = resolve(options.root ?? 'dist');
    let path: string;
    try { path = resolve(root, '.' + decodeURIComponent(url.pathname)); } catch { res.writeHead(400).end(); return; }
    if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    try { if (!(await stat(path)).isFile()) path = resolve(root, 'index.html'); }
    catch { if (extname(path)) { res.writeHead(404).end(); return; } path = resolve(root, 'index.html'); }
    const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2' };
    try { const file = await readFile(path); res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' }).end(req.method === 'HEAD' ? undefined : file); }
    catch { res.writeHead(503).end('Run npm run build before npm start.'); }
  }
  return server;
}
