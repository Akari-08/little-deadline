import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { resolve } from 'node:path';
import type { SpotifyService, SpotifyAction } from '../spotify/service.ts';

export interface CvMusicStatus { phase: 'off' | 'starting' | 'live' | 'error'; message: string; lastGesture: string | null; lastGestureAt: number | null }
const allowed = new Set(['music_toggle', 'music_next', 'music_previous', 'volume_change', 'greet', 'slide_next', 'slide_previous']);
export function parseGestureLine(line: string): { action: string; value: number | null } | { kind: 'ready' | 'error'; message?: string } | null {
  if (line.length > 1024) return null;
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (data.kind === 'ready') return { kind: 'ready' };
  if (data.kind === 'error') return { kind: 'error', message: typeof data.message === 'string' ? data.message.slice(0, 200) : 'Gesture recognition stopped.' };
  if (data.kind !== 'gesture' || typeof data.action !== 'string' || !allowed.has(data.action)) return null;
  const value = data.action === 'volume_change' && typeof data.value === 'number' && Number.isFinite(data.value) && Math.abs(data.value) <= 30 ? data.value : null;
  if (data.action === 'volume_change' && value === null) return null;
  return { action: data.action, value };
}
export class CvMusicBridge {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private state: CvMusicStatus = { phase: 'off', message: 'Computer webcam gestures are off.', lastGesture: null, lastGestureAt: null };
  private readonly spotify: SpotifyService;
  private onGreet: () => void;
  private onSlide: (direction: 'next' | 'previous') => void;
  private commandBusy = false;
  private lastCommandAt = 0;
  constructor(spotify: SpotifyService, onGreet: () => void, onSlide: (direction: 'next' | 'previous') => void) { this.spotify = spotify; this.onGreet = onGreet; this.onSlide = onSlide; }
  status(): CvMusicStatus { return { ...this.state }; }
  start(): void {
    if (this.child) return;
    const command = process.env.LIL_DEADLINE_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
    const args = process.env.LIL_DEADLINE_PYTHON ? [resolve('CV/music_bridge.py')] : process.platform === 'win32' ? ['-3', resolve('CV/music_bridge.py')] : [resolve('CV/music_bridge.py')];
    this.state = { ...this.state, phase: 'starting', message: 'Opening the computer webcam…' };
    const child = spawn(command, args, { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      if (pending.length > 4096) { this.state = { ...this.state, phase: 'error', message: 'Gesture output exceeded its limit.' }; this.stopProcess(); return; }
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        const event = parseGestureLine(line);
        if (!event) continue;
        if ('kind' in event) {
          if (event.kind === 'ready') this.state = { ...this.state, phase: 'live', message: 'Computer webcam gestures are active.' };
          else { this.state = { ...this.state, phase: 'error', message: event.message ?? 'Gesture recognition stopped.' }; this.stopProcess(); }
        } else void this.handle(event.action, event.value);
      }
    });
    child.stderr.on('data', () => {}); // Drain library diagnostics; never expose them or media data.
    child.once('error', () => { this.state = { ...this.state, phase: 'error', message: 'Python could not start. Install Python 3 and CV dependencies.' }; this.child = null; });
    child.once('exit', () => { if (this.child === child) { this.child = null; if (this.state.phase !== 'error') this.state = { ...this.state, phase: 'off', message: 'Computer webcam gestures stopped.' }; } });
  }
  stop(): void { this.state = { ...this.state, phase: 'off', message: 'Computer webcam gestures are off.' }; this.stopProcess(); }
  private stopProcess(): void { this.child?.kill(); this.child = null; }
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
