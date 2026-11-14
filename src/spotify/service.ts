import { createHash, randomBytes } from 'node:crypto';
import type { AppStorage } from '../host/storage.ts';
import { SpotifyArtwork } from './artwork.ts';

export const SPOTIFY_SCOPES = 'user-read-playback-state user-modify-playback-state';
export const SPOTIFY_CALLBACK_PATH = '/api/spotify/callback';
export type SpotifyAction = 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'volume';
export interface SpotifyStatus {
  configured: boolean; connected: boolean; playback: 'playing' | 'paused' | 'no-device' | 'unknown';
  track: string | null; artist: string | null; device: string | null; volume: number | null;
  artworkUrl: string | null; trackUrl: string | null;
  message: string | null; lastUpdatedAt: number | null;
}
type Pending = { state: string; verifier: string; redirectUri: string; expiresAt: number };
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === 'string' ? value.slice(0, 180) : null;
export class SpotifyError extends Error {}

/** One host-side Spotify user session. OAuth state and tokens never reach browser state. */
export class SpotifyService {
  readonly artwork: SpotifyArtwork;
  private readonly storage: AppStorage;
  private readonly fetchFn: typeof fetch;
  private pending: Pending | null = null;
  private refreshFlight: Promise<string> | null = null;
  private statusValue: SpotifyStatus = { configured: false, connected: false, playback: 'unknown', track: null, artist: null, device: null, volume: null, artworkUrl: null, trackUrl: null, message: null, lastUpdatedAt: null };
  private rateLimitUntil = 0;
  private playbackRequest = 0;
  constructor(storage: AppStorage, fetchFn: typeof fetch = fetch) { this.storage = storage; this.fetchFn = fetchFn; this.artwork = new SpotifyArtwork(fetchFn); }
  status(): SpotifyStatus {
    const clientId = this.storage.loadSettings().spotify.clientId;
    return { ...this.statusValue, configured: !!clientId, connected: !!clientId && !!this.storage.loadSpotifyTokens() };
  }
  configure(clientId: string): void {
    if (clientId && !/^[a-f\d]{32}$/i.test(clientId)) throw new SpotifyError('Enter the 32-character Spotify Client ID.');
    const previous = this.storage.loadSettings().spotify.clientId;
    if (previous !== clientId) { this.disconnect(); this.storage.updateSettings(s => { s.spotify.clientId = clientId; }); }
  }
  disconnect(): void {
    this.playbackRequest++;
    this.artwork.clear();
    this.pending = null; this.storage.saveSpotifyTokens(null);
    this.statusValue = { configured: !!this.storage.loadSettings().spotify.clientId, connected: false, playback: 'unknown', track: null, artist: null, device: null, volume: null, artworkUrl: null, trackUrl: null, message: null, lastUpdatedAt: null };
  }
  authorizeUrl(origin: string): string {
    const clientId = this.storage.loadSettings().spotify.clientId;
    if (!clientId) throw new SpotifyError('Save your Spotify Client ID first.');
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new SpotifyError('Open Lil Deadline at its 127.0.0.1 address.');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(24).toString('base64url');
    const redirectUri = origin + SPOTIFY_CALLBACK_PATH;
    this.pending = { state, verifier, redirectUri, expiresAt: Date.now() + 5 * 60_000 };
    const url = new URL('https://accounts.spotify.com/authorize');
    url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
      scope: SPOTIFY_SCOPES, state, code_challenge_method: 'S256', code_challenge: challenge }).toString();
    return url.href;
  }
  async callback(params: URLSearchParams, origin: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.expiresAt < Date.now() || pending.redirectUri !== origin + SPOTIFY_CALLBACK_PATH || params.get('state') !== pending.state) {
      throw new SpotifyError('Spotify sign-in expired or did not match. Start again from Settings.');
    }
    this.pending = null;
    if (params.has('error')) throw new SpotifyError('Spotify sign-in was cancelled.');
    const code = params.get('code');
    if (!code || code.length > 2048) throw new SpotifyError('Spotify did not return an authorization code.');
    const clientId = this.storage.loadSettings().spotify.clientId;
    const response = await this.tokenRequest(new URLSearchParams({ grant_type: 'authorization_code', code,
      redirect_uri: pending.redirectUri, client_id: clientId, code_verifier: pending.verifier }));
    this.saveTokenResponse(response, null);
    this.statusValue.message = 'Spotify connected. Start playback in Spotify on a device to use the controls.';
  }
  private async tokenRequest(body: URLSearchParams): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await this.fetchFn('https://accounts.spotify.com/api/token', { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(8000) }); }
    catch { throw new SpotifyError('Could not reach Spotify. Check your connection and retry.'); }
    if (!response.ok) throw new SpotifyError(response.status === 400 || response.status === 401 ? 'Spotify rejected the connection. Check the Client ID and registered redirect URI.' : `Spotify authorization failed (HTTP ${response.status}).`);
    return obj(await response.json());
  }
  private saveTokenResponse(body: Record<string, unknown>, existingRefresh: string | null): string {
    const accessToken = body.access_token, refreshToken = body.refresh_token ?? existingRefresh;
    const expiresIn = body.expires_in;
    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof expiresIn !== 'number' || expiresIn <= 0) throw new SpotifyError('Spotify returned incomplete credentials. Reconnect your account.');
    this.storage.saveSpotifyTokens({ accessToken, refreshToken, expiresAt: Date.now() + Math.min(expiresIn, 86400) * 1000 });
    return accessToken;
  }
  private async token(): Promise<string> {
    const saved = this.storage.loadSpotifyTokens();
    if (!saved) throw new SpotifyError('Connect Spotify in Settings first.');
    if (saved.expiresAt > Date.now() + 60_000) return saved.accessToken;
    this.refreshFlight ??= (async () => {
      const clientId = this.storage.loadSettings().spotify.clientId;
      try {
        const body = await this.tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: saved.refreshToken, client_id: clientId }));
        return this.saveTokenResponse(body, saved.refreshToken);
      } catch (error) {
        if (error instanceof SpotifyError && error.message.includes('rejected')) this.disconnect();
        throw error;
      }
    })().finally(() => { this.refreshFlight = null; });
    return this.refreshFlight;
  }
  private async api(path: string, method: 'GET' | 'PUT' | 'POST'): Promise<Response> {
    if (Date.now() < this.rateLimitUntil) throw new SpotifyError('Spotify is rate limiting requests. Try again shortly.');
    let response: Response;
    try { response = await this.fetchFn('https://api.spotify.com/v1' + path, { method, redirect: 'error',
      headers: { Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(8000) }); }
    catch (error) { if (error instanceof SpotifyError) throw error; throw new SpotifyError('Spotify is unavailable. Try again.'); }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after') ?? '5');
      this.rateLimitUntil = Date.now() + (Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 60) : 5) * 1000;
      throw new SpotifyError('Spotify is rate limiting requests. Try again shortly.');
    }
    if (response.status === 401) { this.disconnect(); this.statusValue.message = 'Spotify authorization expired. Connect again in Settings.'; throw new SpotifyError(this.statusValue.message); }
    if (response.status === 403) throw new SpotifyError('Spotify denied playback control. A Premium account and an allowed app user are required.');
    if (response.status === 404) throw new SpotifyError('No active Spotify playback device. Open Spotify and start a track there.');
    if (!response.ok) throw new SpotifyError(`Spotify playback request failed (HTTP ${response.status}).`);
    return response;
  }
  async refreshPlayback(force = false): Promise<SpotifyStatus> {
    if (!this.status().connected) return this.status();
    if (!force && this.statusValue.lastUpdatedAt && Date.now() - this.statusValue.lastUpdatedAt < 5000) return this.status();
    const request = ++this.playbackRequest;
    try {
      const response = await this.api('/me/player', 'GET');
      if (request !== this.playbackRequest) { await response.body?.cancel(); return this.status(); }
      if (response.status === 204) {
        this.artwork.clear();
        this.statusValue = { ...this.statusValue, playback: 'no-device', track: null, artist: null, device: null, volume: null, artworkUrl: null, trackUrl: null, message: 'Open Spotify and start a track on a device.', lastUpdatedAt: Date.now() };
      } else {
        const data = obj(await response.json()), item = obj(data.item), device = obj(data.device);
        if (request !== this.playbackRequest) return this.status();
        const artists = Array.isArray(item.artists) ? item.artists.map(v => text(obj(v).name)).filter(Boolean) : [];
        const trackUrl = obj(item.external_urls).spotify;
        this.statusValue = { ...this.statusValue, playback: data.is_playing === true ? 'playing' : 'paused', track: text(item.name), artist: artists.join(', ').slice(0, 180) || null,
          artworkUrl: this.artwork.select(obj(item.album).images),
          trackUrl: typeof trackUrl === 'string' && /^https:\/\/open\.spotify\.com\/track\/[a-z\d]+$/i.test(trackUrl) ? trackUrl : null,
          device: text(device.name), volume: typeof device.volume_percent === 'number' ? Math.max(0, Math.min(100, device.volume_percent)) : null,
          message: null, lastUpdatedAt: Date.now() };
      }
    } catch (error) {
      if (request !== this.playbackRequest) return this.status();
      this.artwork.clear();
      this.statusValue = { ...this.statusValue, playback: 'unknown', track: null, artist: null, device: null, volume: null, artworkUrl: null, trackUrl: null,
        message: error instanceof SpotifyError ? error.message : 'Spotify status unavailable.' };
    }
    return this.status();
  }
  async control(action: SpotifyAction, value?: number): Promise<SpotifyStatus> {
    if (!['play', 'pause', 'toggle', 'next', 'previous', 'volume'].includes(action)) throw new SpotifyError('Unknown music control.');
    if (action === 'toggle' || action === 'volume') await this.refreshPlayback(true);
    if (action === 'toggle' && this.statusValue.playback === 'unknown') throw new SpotifyError(this.statusValue.message ?? 'Spotify playback state is unavailable.');
    if (action === 'toggle') action = this.statusValue.playback === 'playing' ? 'pause' : 'play';
    if (action === 'volume' && (!Number.isFinite(value) || value === undefined || value < 0 || value > 100)) throw new SpotifyError('Volume must be between 0 and 100.');
    const operations: Record<Exclude<SpotifyAction, 'toggle'>, [string, 'PUT' | 'POST']> = {
      play: ['/me/player/play', 'PUT'], pause: ['/me/player/pause', 'PUT'], next: ['/me/player/next', 'POST'],
      previous: ['/me/player/previous', 'POST'], volume: [`/me/player/volume?volume_percent=${Math.round(value!)}`, 'PUT'],
    };
    const [path, method] = operations[action];
    await this.api(path, method);
    this.statusValue.lastUpdatedAt = null;
    return this.refreshPlayback(true);
  }
}
