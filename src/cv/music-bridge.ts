import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SpotifyService, SpotifyAction } from '../spotify/service.ts';
import type { CameraProxy, CameraFrame } from '../camera/proxy.ts';

export interface CvMusicStatus {
  phase: 'off' | 'starting' | 'live' | 'error'; message: string; source: 'esp-camera';
  lastGesture: string | null; lastGestureAt: number | null; framesProcessed: number;
  width: number | null; height: number | null;
}
const allowed = new Set(['music_toggle', 'music_next', 'music_previous', 'volume_change', 'greet', 'slide_next', 'slide_previous']);
type WorkerEvent = { action: string; value: number | null } | { kind: 'ready' | 'error'; message?: string }
  | { kind: 'frame_processed'; timestamp: number; width: number; height: number };
export function parseGestureLine(line: string): WorkerEvent | null {
  if (line.length > 1024) return null;
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (data.kind === 'ready') return { kind: 'ready' };
  if (data.kind === 'error') return { kind: 'error', message: typeof data.message === 'string' ? data.message.slice(0, 200) : 'Gesture recognition stopped.' };
  if (data.kind === 'frame_processed') {
    const { timestamp, width, height } = data;
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0 ||
      typeof width !== 'number' || !Number.isInteger(width) || width < 1 || width > 8192 ||
      typeof height !== 'number' || !Number.isInteger(height) || height < 1 || height > 8192) return null;
    return { kind: 'frame_processed', timestamp, width, height };
  }
  if (data.kind !== 'gesture' || typeof data.action !== 'string' || !allowed.has(data.action)) return null;
  const value = data.action === 'volume_change' && typeof data.value === 'number' && Number.isFinite(data.value) && Math.abs(data.value) <= 30 ? data.value : null;
  if (data.action === 'volume_change' && value === null) return null;
  return { action: data.action, value };
}
function startWorker(): ChildProcessWithoutNullStreams {
  const local = resolve(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  const command = process.env.LIL_DEADLINE_PYTHON || (existsSync(local) ? local : process.platform === 'win32' ? 'py' : 'python3');
  const args = command === 'py' ? ['-3.12', resolve('CV/music_bridge.py')] : [resolve('CV/music_bridge.py')];
  return spawn(command, args, { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}
export class CvMusicBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: CvMusicStatus = { phase: 'off', message: 'ESP32 camera gestures are off.', source: 'esp-camera',
    lastGesture: null, lastGestureAt: null, framesProcessed: 0, width: null, height: null };
  private commandBusy = false;
  private lastCommandAt = 0;
  private unsubscribe: (() => void) | null = null;
  private pending: CameraFrame | null = null;
  private inFlight: number | null = null;
  private lastTimestamp = 0;
  private ready = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private readonly spotify: SpotifyService;
  private readonly onGreet: () => void;
  private readonly onSlide: (direction: 'next' | 'previous') => void;
  private readonly camera: Pick<CameraProxy, 'subscribe'>;
  private readonly spawnWorker: typeof startWorker;
  constructor(spotify: SpotifyService, onGreet: () => void,
    onSlide: (direction: 'next' | 'previous') => void, camera: Pick<CameraProxy, 'subscribe'>,
    spawnWorker = startWorker) {
    this.spotify = spotify; this.onGreet = onGreet; this.onSlide = onSlide; this.camera = camera; this.spawnWorker = spawnWorker;
  }
  status(): CvMusicStatus { return { ...this.state }; }
  start(address: string, token: string | null): void {
    if (this.child) return;
    this.state = { ...this.state, phase: 'starting', message: 'Loading hand detection for the ESP32 camera…',
      framesProcessed: 0, width: null, height: null };
    try {
      const child = this.spawnWorker(); this.child = child;
      this.armWatchdog(45_000, 'Hand detection did not start. Check the Python dependencies.');
      let pending = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (this.child !== child) return;
        pending += chunk;
        if (pending.length > 4096) { this.fail('Gesture output exceeded its limit.'); return; }
        let end: number;
        while (this.child === child && (end = pending.indexOf('\n')) >= 0) {
          const event = parseGestureLine(pending.slice(0, end)); pending = pending.slice(end + 1);
          if (!event) continue;
          if (!('kind' in event)) { void this.handle(event.action, event.value); continue; }
          if (event.kind === 'error') { this.fail(event.message ?? 'Gesture recognition stopped.'); return; }
          if (event.kind === 'ready') {
            this.ready = true;
            this.state = { ...this.state, message: 'Waiting for an ESP32 camera frame…' };
            this.armWatchdog(10_000, 'No camera frame was processed. Check the ESP32 connection.'); this.sendLatest();
          } else if (event.kind === 'frame_processed') {
            if (event.timestamp !== this.inFlight) { this.fail('Gesture worker returned an unexpected frame.'); return; }
            this.inFlight = null;
            this.state = { ...this.state, phase: 'live', message: this.state.phase === 'live' ? this.state.message : 'ESP32 camera gestures are active.',
              framesProcessed: this.state.framesProcessed + 1, width: event.width, height: event.height };
            this.armWatchdog(10_000, 'ESP32 gesture processing stopped receiving frames.'); this.sendLatest();
          }
        }
      });
      child.stderr.on('data', () => {}); // Drain library diagnostics without exposing media or local paths.
      child.stdin.on('error', () => { if (this.child === child) this.fail('Gesture worker stopped receiving camera frames.'); });
      child.once('error', () => { if (this.child === child) this.fail('Python could not start. Install the CV dependencies in .venv.'); });
      child.once('exit', () => { if (this.child === child) this.fail('Gesture worker stopped. Check the CV dependencies and retry.'); });
      this.unsubscribe = this.camera.subscribe(address, token, { kind: 'gestures',
        onFrame: frame => { if (this.child === child) { this.pending = frame; this.sendLatest(); } },
        onError: message => { if (this.child === child) this.fail(message); } });
    } catch (error) { this.fail(error instanceof Error ? error.message : 'Could not start ESP32 gestures.'); }
  }
  private armWatchdog(ms: number, message: string): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.fail(message), ms);
  }
  private sendLatest(): void {
    if (!this.child || !this.ready || this.inFlight !== null || !this.pending) return;
    const frame = this.pending; this.pending = null;
    if (frame.jpeg.length > 512 * 1024) { this.fail('Camera frame exceeds the gesture limit.'); return; }
    const timestamp = Math.max(this.lastTimestamp + 1, Math.floor(frame.receivedAt));
    this.lastTimestamp = timestamp; this.inFlight = timestamp;
    const header = Buffer.alloc(12); header.writeUInt32LE(frame.jpeg.length); header.writeBigUInt64LE(BigInt(timestamp), 4);
    // One outstanding packet; the next frame waits for the Python acknowledgement.
    this.child.stdin.write(Buffer.concat([header, frame.jpeg]));
  }
  stop(): void { this.state = { ...this.state, phase: 'off', message: 'ESP32 camera gestures are off.' }; this.stopProcess(); }
  private fail(message: string): void { this.state = { ...this.state, phase: 'error', message }; this.stopProcess(); }
  private stopProcess(): void {
    const child = this.child; this.child = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.pending = null; this.inFlight = null; this.ready = false;
    if (this.watchdog) clearTimeout(this.watchdog); this.watchdog = null;
    child?.stdin.destroy(); child?.kill();
  }
  private async handle(action: string, value: number | null): Promise<void> {
    if (!this.child || this.state.phase !== 'live') return;
    this.state = { ...this.state, lastGesture: action, lastGestureAt: Date.now() };
    if (action === 'greet') { this.onGreet(); return; }
    if (action === 'slide_next' || action === 'slide_previous') { this.onSlide(action === 'slide_next' ? 'next' : 'previous'); return; }
    if (!this.spotify.status().connected) { this.state = { ...this.state, message: 'Connect Spotify to use music gestures. Slide navigation still works.' }; return; }
    if (this.commandBusy || Date.now() - this.lastCommandAt < (action === 'volume_change' ? 250 : 600)) return;
    this.commandBusy = true; this.lastCommandAt = Date.now();
    try {
      const mapping: Record<string, SpotifyAction> = { music_toggle: 'toggle', music_next: 'next', music_previous: 'previous', volume_change: 'volume' };
      if (action === 'volume_change') {
        const current = await this.spotify.refreshPlayback(true);
        if (current.volume === null) throw new Error('Start Spotify playback on a volume-capable device.');
        await this.spotify.control('volume', Math.max(0, Math.min(100, Math.round(current.volume + value!))));
      } else await this.spotify.control(mapping[action]!);
    } catch (error) {
      this.state = { ...this.state, message: error instanceof Error ? error.message : 'Spotify music control failed.' };
    } finally { this.commandBusy = false; }
  }
}
