import { existsSync } from 'node:fs';
import { Application } from '../src/host/application.ts';
import { createAppServer } from '../src/host/server.ts';
if (existsSync('.env')) process.loadEnvFile('.env');
const dev = process.argv.includes('--dev');
const port = Number(process.env.LIL_DEADLINE_PORT || 3210);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('LIL_DEADLINE_PORT must be 1024–65535.');
const vite = dev ? await (await import('vite')).createServer({ server: {
  middlewareMode: true, hmr: false,
  fs: { deny: ['.env', '.env.*', '**/secrets.json', '**/secrets.json.*', '**/.taskpet-data/**', '**/.git/**', '**/*.pem', '**/*.crt'] },
}, appType: 'spa' }) : undefined;
// The app-wide Claude key is read from .env (gitignored) and handed to the host only; it is never
// exposed to the browser bundle (no VITE_ prefix) and never logged.
const app = new Application(undefined, { anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null });
for (const warning of app.storage.warnings) console.warn(warning);
const server = createAppServer(app, { dev: vite });
server.on('error', async () => { console.error('Could not start Lil Deadline. Check whether the local port is already in use.'); await app.dispose(); await vite?.close(); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Lil Deadline · http://127.0.0.1:${port} · ${dev ? 'development' : 'production'}`));
let closing = false;
async function close() { if (closing) return; closing = true; await app.dispose(); await vite?.close(); server.close(); server.closeAllConnections(); }
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
