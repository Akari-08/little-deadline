import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { parseDeviceAddress } from '../device/address.ts';
import { MultipartParser } from './multipart.ts';

export type CameraStatus = { phase: 'off' | 'loading' | 'live' | 'error'; message: string; frames: number; lastFrameAgeMs: number | null };
export class CameraProxy {
  private controller: AbortController | null = null;
  private phase: CameraStatus['phase'] = 'off';
  private message = 'Camera is off';
  private frames = 0;
  private lastFrameAt: number | null = null;
  private readonly fetchFn: typeof fetch;
  constructor(fetchFn: typeof fetch = fetch) { this.fetchFn = fetchFn; }
  status(): CameraStatus {
    return { phase: this.phase, message: this.message, frames: this.frames, lastFrameAgeMs: this.lastFrameAt === null ? null : performance.now() - this.lastFrameAt };
  }
  stop(): void { this.controller?.abort(); }
  async serve(_req: IncomingMessage, res: ServerResponse, address: string, token: string | null): Promise<void> {
    if (this.controller) { res.writeHead(409).end('The camera already has an active viewer.'); return; }
    const parsed = parseDeviceAddress(address);
    if (!parsed.ok || !token) { res.writeHead(503).end('Configure the device address and token first.'); return; }
    const target = new URL(parsed.value.url); target.protocol = 'http:'; target.port = '8080'; target.pathname = '/stream';
    const controller = new AbortController(); this.controller = controller;
    this.phase = 'loading'; this.message = 'Opening camera'; this.lastFrameAt = null;
    const cancel = () => controller.abort(); res.once('close', cancel);
    let watchdog = setTimeout(cancel, 8000);
    try {
      const upstream = await this.fetchFn(target, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: controller.signal });
      if (!upstream.ok || !upstream.body) {
        this.message = upstream.status === 401 ? 'Camera authentication failed. Check your device token.' : upstream.status === 503 ? 'Camera unavailable on the device.' : `Camera returned HTTP ${upstream.status}.`;
        this.phase = 'error'; res.writeHead(upstream.status === 401 ? 401 : 503).end(this.message); return;
      }
      if (!/multipart\/x-mixed-replace\s*;\s*boundary="?taskpetframe"?/i.test(upstream.headers.get('content-type') ?? '')) throw new Error('format');
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=taskpetframe', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      const parser = new MultipartParser();
      for await (const chunk of upstream.body) {
        for (const frame of parser.push(chunk)) {
          clearTimeout(watchdog); watchdog = setTimeout(cancel, 8000);
          const output = Buffer.concat([Buffer.from(`\r\n--taskpetframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`), frame]);
          if (!res.write(output)) await once(res, 'drain', { signal: controller.signal });
          this.frames++; this.lastFrameAt = performance.now(); this.phase = 'live'; this.message = 'Live camera · no recording';
        }
      }
      parser.finish();
      throw new Error('ended');
    } catch {
      if (res.destroyed) { this.phase = 'off'; this.message = 'Camera is off'; }
      else { this.phase = 'error'; this.message = 'Camera disconnected or timed out. Retry when the device is available.'; }
      if (!res.headersSent && !res.destroyed) res.writeHead(503).end(this.message);
      else res.destroy();
    } finally {
      clearTimeout(watchdog); controller.abort(); res.off('close', cancel);
      if (this.controller === controller) this.controller = null;
      if (this.phase !== 'error') { this.phase = 'off'; this.message = 'Camera is off'; }
    }
  }
}
