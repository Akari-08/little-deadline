import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseDeviceAddress } from '../device/address.ts';
import { MultipartParser, jpegDimensions } from './multipart.ts';

export type CameraStatus = {
  phase: 'off' | 'loading' | 'live' | 'error'; message: string; frames: number; lastFrameAgeMs: number | null;
  width: number | null; height: number | null; deliveredFps: number | null; gestureConsumer: boolean; previewConsumer: boolean;
};
export type CameraFrame = { jpeg: Buffer; receivedAt: number };
export interface CameraConsumer {
  kind: 'preview' | 'gestures'; onFrame: (frame: CameraFrame) => void; onError: (message: string, status: number) => void;
}
type Session = { address: string; token: string; controller: AbortController; consumers: Set<CameraConsumer>; done: Promise<void> };
class CameraError extends Error {
  readonly status: number;
  constructor(message: string, status = 503) { super(message); this.status = status; }
}

/** One authenticated ESP request, shared by the preview and local gesture worker. */
export class CameraProxy {
  private session: Session | null = null;
  private retiring: Promise<void> = Promise.resolve();
  private viewer: ServerResponse | null = null;
  private phase: CameraStatus['phase'] = 'off';
  private message = 'Camera is off';
  private frames = 0;
  private lastFrameAt: number | null = null;
  private dimensions: { width: number; height: number } | null = null;
  private receipts: number[] = [];
  private readonly fetchFn: typeof fetch;
  constructor(fetchFn: typeof fetch = fetch) { this.fetchFn = fetchFn; }
  status(): CameraStatus {
    const now = performance.now(), recent = this.receipts.filter(t => now - t <= 5000);
    return { phase: this.phase, message: this.message, frames: this.frames,
      lastFrameAgeMs: this.lastFrameAt === null ? null : now - this.lastFrameAt,
      width: this.dimensions?.width ?? null, height: this.dimensions?.height ?? null,
      deliveredFps: recent.length > 1 ? (recent.length - 1) * 1000 / Math.max(1, now - recent[0]!) : null,
      gestureConsumer: !!this.session && [...this.session.consumers].some(c => c.kind === 'gestures'), previewConsumer: !!this.viewer };
  }
  subscribe(address: string, token: string | null, consumer: CameraConsumer): () => void {
    const parsed = parseDeviceAddress(address);
    if (!parsed.ok || !token) throw new CameraError('Configure the device address and token first.');
    if (this.session && (this.session.address !== parsed.value.url || this.session.token !== token)) throw new CameraError('Camera settings changed. Stop the camera and retry.', 409);
    if (!this.session) {
      const session: Session = { address: parsed.value.url, token, controller: new AbortController(), consumers: new Set(), done: Promise.resolve() };
      this.session = session;
      this.phase = 'loading'; this.message = 'Opening ESP32 camera'; this.lastFrameAt = null;
      this.frames = 0; this.dimensions = null; this.receipts = [];
      session.done = this.retiring.then(() => this.run(session));
    }
    const session = this.session;
    session.consumers.add(consumer);
    return () => {
      session.consumers.delete(consumer);
      if (this.session === session && !session.consumers.size) {
        this.retire(session); this.phase = 'off'; this.message = 'Camera is off';
      }
    };
  }
  private retire(session: Session): void {
    if (this.session === session) this.session = null;
    session.controller.abort(); this.retiring = session.done;
  }
  stop(): void {
    const session = this.session;
    if (session) {
      this.retire(session);
      const consumers = [...session.consumers]; session.consumers.clear();
      for (const consumer of consumers) consumer.onError('ESP32 camera stopped.', 503);
    }
    this.phase = 'off'; this.message = 'Camera is off';
  }
  private async run(session: Session): Promise<void> {
    if (session.controller.signal.aborted) return;
    const target = new URL(session.address); target.protocol = 'http:'; target.port = '8080'; target.pathname = '/stream';
    let watchdog = setTimeout(() => session.controller.abort(), 8000);
    try {
      const upstream = await this.fetchFn(target, { headers: { Authorization: `Bearer ${session.token}` }, redirect: 'error', signal: session.controller.signal });
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        throw new CameraError(upstream.status === 401 ? 'Camera authentication failed. Check your device token.' : upstream.status === 503 ? 'Camera unavailable on the device.' : `Camera returned HTTP ${upstream.status}.`, upstream.status === 401 ? 401 : 503);
      }
      if (!/multipart\/x-mixed-replace\s*;\s*boundary="?taskpetframe"?/i.test(upstream.headers.get('content-type') ?? '')) {
        await upstream.body.cancel(); throw new CameraError('Unsupported camera stream format.');
      }
      const parser = new MultipartParser();
      for await (const chunk of upstream.body) {
        if (this.session !== session) break;
        for (const jpeg of parser.push(chunk)) {
          if (this.session !== session) break;
          clearTimeout(watchdog); watchdog = setTimeout(() => session.controller.abort(), 8000);
          const receivedAt = performance.now();
          this.frames++; this.lastFrameAt = receivedAt; this.receipts.push(receivedAt);
          this.receipts = this.receipts.filter(t => receivedAt - t <= 5000).slice(-150);
          this.dimensions = jpegDimensions(jpeg); this.phase = 'live'; this.message = 'Live ESP32 camera · no recording';
          for (const consumer of [...session.consumers]) consumer.onFrame({ jpeg, receivedAt });
        }
      }
      parser.finish(); throw new CameraError('Camera disconnected or timed out. Retry when the device is available.');
    } catch (error) {
      if (this.session !== session) return;
      this.retire(session); this.phase = 'error';
      this.message = error instanceof CameraError ? error.message : 'Camera disconnected or timed out. Retry when the device is available.';
      const consumers = [...session.consumers]; session.consumers.clear();
      for (const consumer of consumers) consumer.onError(this.message, error instanceof CameraError ? error.status : 503);
    } finally { clearTimeout(watchdog); session.controller.abort(); }
  }
  async serve(_req: IncomingMessage, res: ServerResponse, address: string, token: string | null): Promise<void> {
    if (this.viewer) { res.writeHead(409).end('The camera already has an active viewer.'); return; }
    this.viewer = res;
    let unsubscribe = () => {}, pending: CameraFrame | null = null, blocked = false;
    const send = (frame: CameraFrame) => {
      if (res.destroyed) return;
      if (blocked) { pending = frame; return; }
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=taskpetframe', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      blocked = !res.write(Buffer.concat([Buffer.from(`\r\n--taskpetframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.jpeg.length}\r\n\r\n`), frame.jpeg]));
    };
    const drain = () => { blocked = false; if (pending) { const frame = pending; pending = null; send(frame); } };
    res.on('drain', drain);
    res.once('close', () => { pending = null; unsubscribe(); res.off('drain', drain); if (this.viewer === res) this.viewer = null; });
    const fail = (message: string, status: number) => {
      if (res.destroyed) return;
      if (!res.headersSent) res.writeHead(status).end(message); else res.destroy();
    };
    try { unsubscribe = this.subscribe(address, token, { kind: 'preview', onFrame: send, onError: fail }); }
    catch (error) { fail(error instanceof CameraError ? error.message : 'Camera unavailable.', error instanceof CameraError ? error.status : 503); }
  }
}
