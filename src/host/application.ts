import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { AppStorage, checkApiCredential, normalizeCanvasPersonalToken } from './storage.ts';
import { DeviceService } from './device-service.ts';
import { TaskStore } from '../tasks/store.ts';
import { TaskSync } from '../tasks/sync.ts';
import { CanvasTaskProvider } from '../canvas/provider.ts';
import { createCanvasAuth } from '../canvas/create-auth.ts';
import { parseCanvasBaseUrl } from '../canvas/base-url.ts';
import { NotionTaskProvider } from '../notion/provider.ts';
import { CameraProxy } from '../camera/proxy.ts';
import { normalizeCompanion, celebrate, settleTimer, timerAction, remainingTime } from '../pet/state.ts';
import { parseDeviceAddress } from '../device/address.ts';
import { checkDeviceToken } from '../device/token.ts';
import { SpotifyService, type SpotifyAction } from '../spotify/service.ts';
import { CvMusicBridge } from '../cv/music-bridge.ts';
import { isDisplaySlide, moveDisplaySlide } from '../pet/slides.ts';
import type { RenderedFrame } from '../device/streamer.ts';
import type { TaskView } from '../tasks/store.ts';
import { NotificationCenter } from '../notifications/center.ts';
import { Assistant, type AssistantContext } from '../assistant/service.ts';

export class InputError extends Error {}
const string = (v: unknown) => typeof v === 'string' ? v : '';
export function privateAddress(address: string): boolean {
  return /^127\./.test(address) || /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address) || address === '::1' || /^f[cd][a-f\d]{2}:/i.test(address);
}
export async function validateLanAddress(address: string): Promise<string> {
  const parsed = parseDeviceAddress(address);
  if (!parsed.ok) throw new InputError(parsed.error);
  const p = parsed.value;
  if (!p.isLoopback && p.port !== 81) throw new InputError('The ESP32 display uses port 81.');
  let addresses;
  try { addresses = await lookup(p.hostname.replace(/^\[|\]$/g, ''), { all: true }); }
  catch { throw new InputError('Device hostname could not be resolved. Try its LAN IP address.'); }
  if (!addresses.length || addresses.some(a => !privateAddress(a.address))) throw new InputError('Use a private LAN device IP or .local hostname.');
  return p.url;
}

export class Application {
  readonly storage: AppStorage;
  readonly tasks: TaskStore;
  readonly device: DeviceService;
  readonly camera: CameraProxy;
  readonly spotify: SpotifyService;
  readonly cvMusic: CvMusicBridge;
  readonly companion;
  readonly canvasSync: TaskSync;
  readonly notionSync: TaskSync;
  readonly notifications: NotificationCenter;
  readonly assistant: Assistant;
  readonly instanceId = randomUUID();
  private frame: RenderedFrame | null = null;
  private frameAt = 0;
  private seq = 0;
  private owner: string | null = null;
  private tick: ReturnType<typeof setInterval>;
  private spotifyTick: ReturnType<typeof setInterval>;
  private notificationTick: ReturnType<typeof setInterval>;
  /**
   * @param options.geminiApiKey App-wide Gemini key from the host environment (.env), shared by
   *   every user of this host — users never enter their own.
   * @param options.geminiModel Optional model override (GEMINI_MODEL).
   */
  constructor(storage = new AppStorage(), options: { geminiApiKey?: string | null; geminiModel?: string | null } = {}) {
    this.storage = storage;
    const rawKey = options.geminiApiKey?.trim() ?? '';
    const geminiKey = rawKey && !checkApiCredential(rawKey, 'GEMINI_API_KEY') ? rawKey : null;
    if (rawKey && !geminiKey) storage.warnings.push('GEMINI_API_KEY in .env is not a valid key; Ask Sprout is disabled until it is fixed.');
    const rawModel = options.geminiModel?.trim() ?? '';
    const geminiModel = /^[a-z0-9][a-z0-9.\-]{1,80}$/i.test(rawModel) ? rawModel : undefined;
    if (rawModel && !geminiModel) storage.warnings.push('GEMINI_MODEL in .env is not a valid model name; using the default model.');
    this.companion = normalizeCompanion(storage.loadCompanion());
    this.tasks = new TaskStore({ persistence: { load: () => storage.loadTasksFile(), save: value => storage.saveTasksFile(value) } });
    this.tasks.on('completed', ({ ids }) => { celebrate(this.companion, Date.now(), ids.length * 10); this.save(); });
    this.device = new DeviceService({ source: { latest: () => performance.now() - this.frameAt < 1500 ? this.frame : null }, targetFps: 5 });
    this.device.supervisor.on('sessionEnded', () => { this.frame = null; });
    this.camera = new CameraProxy();
    this.spotify = new SpotifyService(storage);
    this.cvMusic = new CvMusicBridge(this.spotify,
      () => { this.companion.pet.lastInteractionAt = Date.now(); this.companion.pet.celebrateUntil = Date.now() + 2000; this.save(); },
      direction => { this.companion.displaySlide = moveDisplaySlide(this.companion.displaySlide, direction); this.save(); }, this.camera);
    const settings = storage.loadSettings();
    this.device.configure({ address: settings.device.address, token: storage.loadDeviceToken() });
    this.canvasSync = new TaskSync({ store: this.tasks, intervalMs: () => storage.loadSettings().canvas.refreshMinutes * 60_000,
      provider: new CanvasTaskProvider({ loadSettings: () => storage.loadSettings().canvas, createAuth: () => createCanvasAuth(storage) }) });
    this.notionSync = new TaskSync({ store: this.tasks, intervalMs: () => 15 * 60_000,
      provider: new NotionTaskProvider(() => ({ token: storage.loadNotionToken(), dataSourceId: this.companion.notion.dataSourceId })) });
    // [notifications] deadline/event notifications, evaluated on the host.
    this.notifications = new NotificationCenter({ load: () => storage.loadNotifications(), save: value => storage.saveNotifications(value) });
    this.tasks.on('changed', () => this.refreshNotifications());
    this.canvasSync.on('status', () => this.refreshNotifications()); this.notionSync.on('status', () => this.refreshNotifications());
    this.notificationTick = setInterval(() => this.refreshNotifications(), 30_000);
    this.refreshNotifications();
    // [assistant] Gemini-backed study assistant; the app-wide key stays in host memory only.
    this.assistant = new Assistant({ apiKey: geminiKey, model: geminiModel, context: () => this.assistantContext() });
    this.canvasSync.start(); this.notionSync.start();
    this.tick = setInterval(() => { if (settleTimer(this.companion, Date.now())) { this.save(); this.refreshNotifications(); } }, 500);
    this.spotifyTick = setInterval(() => { if (this.spotify.status().connected) void this.spotify.refreshPlayback(); }, 10_000);
    this.save();
  }
  save(): void { this.storage.saveCompanion(this.companion); }
  /** Tasks from every provider, regardless of which one the dashboard is showing. */
  allTasks(): TaskView[] { return (['mock', 'canvas', 'notion'] as const).flatMap(p => this.tasks.list(p)); }
  refreshNotifications(): void {
    this.notifications.update({ now: Date.now(), tasks: this.allTasks(), focusSessions: this.companion.timer.sessions,
      providers: { canvas: this.canvasSync.status(), notion: this.notionSync.status() } });
  }
  assistantContext(): AssistantContext {
    const now = Date.now(), d = this.device.diagnostics(), sensors = d.sensors, spotify = this.spotify.status();
    const envOk = sensors.environment.status === 'live' || sensors.environment.status === 'simulated';
    const humOk = sensors.environment.humidity === 'live' || sensors.environment.humidity === 'simulated';
    return { now, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, tasks: this.allTasks(),
      providers: { canvas: this.canvasSync.status(), notion: this.notionSync.status() },
      focus: { sessions: this.companion.timer.sessions, running: this.companion.timer.startedAt !== null,
        remainingMs: remainingTime(this.companion, now), selectedTaskId: this.companion.selectedId },
      music: { connected: spotify.connected, track: spotify.track, artist: spotify.artist },
      environment: { temperatureC: envOk ? sensors.latest?.environment.temperatureC ?? null : null,
        humidityPct: humOk ? sensors.latest?.environment.humidityPct ?? null : null,
        source: d.live ? sensors.source : 'unavailable' } };
  }
  snapshot() {
    const settings = this.storage.loadSettings(), diagnostics = this.device.diagnostics();
    return { instanceId: this.instanceId, serverNow: Date.now(), companion: this.companion, tasks: this.tasks.list(this.companion.provider),
      progress: this.tasks.progress(this.companion.provider), settings,
      secrets: { ...this.storage.describeSecrets(), notionTokenSet: !!this.storage.loadNotionToken() },
      diagnostics, camera: this.camera.status(), providers: { canvas: this.canvasSync.status(), notion: this.notionSync.status() },
      spotify: this.spotify.status(), cvMusic: this.cvMusic.status(),
      notifications: this.notifications.status(Date.now()), assistant: this.assistant.status(),
      render: { fresh: this.frame !== null && performance.now() - this.frameAt < 1500, owner: this.owner },
    };
  }
  acceptFrame(owner: string, bytes: Buffer): boolean {
    if (!/^[a-f\d-]{36}$/i.test(owner) || bytes.length !== 240 * 320 * 4) throw new InputError('Expected one complete 240×320 RGBA render and a renderer ID.');
    if (this.owner && this.owner !== owner && performance.now() - this.frameAt < 2000) return false;
    this.owner = owner; this.frameAt = performance.now(); this.frame = { seq: ++this.seq, rgba: bytes };
    return true;
  }
  async action(path: string, body: Record<string, unknown>): Promise<void> {
    const s = this.companion;
    if (path === '/api/tasks/add' || path === '/api/tasks/edit') {
      try {
        const input = { title: string(body.title), course: string(body.course) || null, dueAt: string(body.dueAt) || null, priority: body.priority as 'low' | 'normal' | 'high' | undefined };
        if (path.endsWith('/add')) this.tasks.addMock(input); else this.tasks.editMock(string(body.id), input);
      } catch (e) { throw new InputError(e instanceof Error ? e.message : 'Invalid task'); }
    } else if (path === '/api/tasks/complete') {
      if (typeof body.completed !== 'boolean') throw new InputError('Specify completion.');
      if (!this.tasks.list(s.provider).some(t => t.id === body.id)) throw new InputError('Task no longer exists.');
      this.tasks.setCompleted(string(body.id), body.completed);
    } else if (path === '/api/tasks/delete') {
      if (!this.tasks.list('mock').some(t => t.id === body.id)) throw new InputError('Only local tasks can be deleted.');
      this.tasks.removeMock(string(body.id));
    } else if (path === '/api/tasks/reset') this.tasks.resetMock();
    else if (path === '/api/select') {
      if (!this.tasks.list(s.provider).some(t => t.id === body.id)) throw new InputError('Task no longer exists.');
      s.selectedId = string(body.id);
    } else if (path === '/api/provider') {
      if (!['mock', 'canvas', 'notion'].includes(string(body.provider))) throw new InputError('Unknown provider.');
      s.provider = body.provider as typeof s.provider; s.selectedId = null;
    } else if (path === '/api/pet') {
      s.pet.lastInteractionAt = Date.now();
      s.pet.celebrateUntil = Date.now() + 2000;
      s.pet.lean = body.direction === 'left' ? -1 : body.direction === 'right' ? 1 : 0;
    } else if (path === '/api/display/slide') {
      if (isDisplaySlide(body.slide)) s.displaySlide = body.slide;
      else if (body.direction === 'next' || body.direction === 'previous') s.displaySlide = moveDisplaySlide(s.displaySlide, body.direction);
      else throw new InputError('Choose a display slide or direction.');
    } else if (path === '/api/timer') {
      if (!['start', 'pause', 'reset'].includes(string(body.action))) throw new InputError('Unknown timer action.');
      timerAction(s, body.action as 'start' | 'pause' | 'reset', Date.now());
    } else if (path === '/api/settings/device') {
      const address = string(body.address).trim();
      const normalized = address ? await validateLanAddress(address) : '';
      const token = typeof body.token === 'string' && body.token ? body.token : null;
      if (token) { const error = checkDeviceToken(token); if (error) throw new InputError(error); }
      this.cvMusic.stop(); this.camera.stop();
      if (token) this.storage.saveDeviceToken(token);
      if (body.clearToken === true) this.storage.saveDeviceToken(null);
      this.storage.updateSettings(settings => { settings.device.address = normalized; settings.device.autoConnect = false; });
      this.device.configure({ address: normalized, token: this.storage.loadDeviceToken() });
    } else if (path === '/api/device/connect') {
      await validateLanAddress(this.storage.loadSettings().device.address);
      this.device.connect();
    } else if (path === '/api/device/disconnect') { this.device.disconnect(); this.cvMusic.stop(); this.camera.stop(); this.frame = null; }
    else if (path === '/api/settings/canvas') {
      if (this.canvasSync.status().refreshing) throw new InputError('Wait for the current Canvas refresh before changing settings.');
      const previous = this.storage.loadSettings().canvas.baseUrl;
      const url = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : previous;
      const parsed = url ? parseCanvasBaseUrl(url) : null;
      if (parsed && !parsed.ok) throw new InputError(parsed.error);
      const token = normalizeCanvasPersonalToken(string(body.token));
      if (token && !parsed) throw new InputError("Set your school's Canvas address once before saving an API token.");
      if (parsed?.ok && previous && parsed.origin !== previous && !token) throw new InputError('Enter a new Canvas API token when changing schools.');
      if (token) { const error = checkApiCredential(token, 'Canvas token'); if (error) throw new InputError(error); this.storage.saveCanvasPersonalToken(token); }
      if (body.clearToken === true) this.storage.saveCanvasPersonalToken(null);
      if (!parsed && previous) this.storage.saveCanvasPersonalToken(null);
      this.storage.updateSettings(settings => { settings.canvas.baseUrl = parsed?.ok ? parsed.origin : ''; });
      this.canvasSync.start();
    } else if (path === '/api/settings/notion') {
      if (this.notionSync.status().refreshing) throw new InputError('Wait for the current Notion refresh before changing settings.');
      const id = string(body.dataSourceId).trim(), token = string(body.token);
      if (id && !/^[a-f\d-]{32,36}$/i.test(id)) throw new InputError('Enter the Notion data source UUID.');
      if (token) { const error = checkApiCredential(token, 'Notion token'); if (error) throw new InputError(error); this.storage.saveNotionToken(token); }
      if (body.clearToken === true) this.storage.saveNotionToken(null);
      s.notion.dataSourceId = id; this.notionSync.start();
    } else if (path === '/api/settings/spotify') {
      this.cvMusic.stop();
      try { this.spotify.configure(string(body.clientId).trim()); }
      catch (error) { throw new InputError(error instanceof Error ? error.message : 'Invalid Spotify Client ID.'); }
    } else if (path === '/api/spotify/disconnect') {
      this.cvMusic.stop(); this.spotify.disconnect();
    } else if (path === '/api/spotify/control') {
      try { await this.spotify.control(string(body.command) as SpotifyAction, typeof body.value === 'number' ? body.value : undefined); }
      catch (error) { throw new InputError(error instanceof Error ? error.message : 'Spotify control failed.'); }
    } else if (path === '/api/cv/start') {
      const address = await validateLanAddress(this.storage.loadSettings().device.address);
      try { this.cvMusic.start(address, this.storage.loadDeviceToken()); } catch (error) { throw new InputError(error instanceof Error ? error.message : 'Could not start music gestures.'); }
    } else if (path === '/api/cv/stop') this.cvMusic.stop();
    else if (path.startsWith('/api/notifications/')) {
      try { this.notifications.action(path.slice('/api/notifications/'.length), body); }
      catch (error) { throw new InputError(error instanceof Error ? error.message : 'Notification change failed.'); }
    }
    else if (path === '/api/sync/canvas') await this.canvasSync.refreshNow();
    else if (path === '/api/sync/notion') await this.notionSync.refreshNow();
    else throw new InputError('Unknown action.');
    this.save();
  }
  async dispose(): Promise<void> { clearInterval(this.tick); clearInterval(this.notificationTick); clearInterval(this.spotifyTick); this.spotify.artwork.clear(); this.cvMusic.stop(); this.camera.stop(); this.canvasSync.stop(); this.notionSync.stop(); await this.device.dispose(); }
}
export type AppSnapshot = ReturnType<Application['snapshot']>;
