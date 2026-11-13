import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { AppStorage, checkApiCredential } from './storage.ts';
import { DeviceService } from './device-service.ts';
import { TaskStore } from '../tasks/store.ts';
import { TaskSync } from '../tasks/sync.ts';
import { CanvasTaskProvider } from '../canvas/provider.ts';
import { createCanvasAuth } from '../canvas/create-auth.ts';
import { parseCanvasBaseUrl } from '../canvas/base-url.ts';
import { NotionTaskProvider } from '../notion/provider.ts';
import { CameraProxy } from '../camera/proxy.ts';
import { normalizeCompanion, celebrate, settleTimer, timerAction } from '../pet/state.ts';
import { parseDeviceAddress } from '../device/address.ts';
import { checkDeviceToken } from '../device/token.ts';
import type { RenderedFrame } from '../device/streamer.ts';

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
  readonly companion;
  readonly canvasSync: TaskSync;
  readonly notionSync: TaskSync;
  readonly instanceId = randomUUID();
  private frame: RenderedFrame | null = null;
  private frameAt = 0;
  private seq = 0;
  private owner: string | null = null;
  private tick: ReturnType<typeof setInterval>;
  constructor(storage = new AppStorage()) {
    this.storage = storage;
    this.companion = normalizeCompanion(storage.loadCompanion());
    this.tasks = new TaskStore({ persistence: { load: () => storage.loadTasksFile(), save: value => storage.saveTasksFile(value) } });
    this.tasks.on('completed', ({ ids }) => { celebrate(this.companion, Date.now(), ids.length * 10); this.save(); });
    this.device = new DeviceService({ source: { latest: () => performance.now() - this.frameAt < 1500 ? this.frame : null }, targetFps: 5 });
    this.device.supervisor.on('sessionEnded', () => { this.frame = null; });
    this.camera = new CameraProxy();
    const settings = storage.loadSettings();
    this.device.configure({ address: settings.device.address, token: storage.loadDeviceToken() });
    this.canvasSync = new TaskSync({ store: this.tasks, intervalMs: () => storage.loadSettings().canvas.refreshMinutes * 60_000,
      provider: new CanvasTaskProvider({ loadSettings: () => storage.loadSettings().canvas, createAuth: () => createCanvasAuth(storage) }) });
    this.notionSync = new TaskSync({ store: this.tasks, intervalMs: () => 15 * 60_000,
      provider: new NotionTaskProvider(() => ({ token: storage.loadNotionToken(), dataSourceId: this.companion.notion.dataSourceId })) });
    this.canvasSync.start(); this.notionSync.start();
    this.tick = setInterval(() => { if (settleTimer(this.companion, Date.now())) this.save(); }, 500);
    this.save();
  }
  save(): void { this.storage.saveCompanion(this.companion); }
  snapshot() {
    const settings = this.storage.loadSettings(), diagnostics = this.device.diagnostics();
    return { instanceId: this.instanceId, serverNow: Date.now(), companion: this.companion, tasks: this.tasks.list(this.companion.provider),
      progress: this.tasks.progress(this.companion.provider), settings,
      secrets: { ...this.storage.describeSecrets(), notionTokenSet: !!this.storage.loadNotionToken() },
      diagnostics, camera: this.camera.status(), providers: { canvas: this.canvasSync.status(), notion: this.notionSync.status() },
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
    } else if (path === '/api/timer') {
      if (!['start', 'pause', 'reset'].includes(string(body.action))) throw new InputError('Unknown timer action.');
      timerAction(s, body.action as 'start' | 'pause' | 'reset', Date.now());
    } else if (path === '/api/settings/device') {
      const address = string(body.address).trim();
      const normalized = address ? await validateLanAddress(address) : '';
      const token = typeof body.token === 'string' && body.token ? body.token : null;
      if (token) { const error = checkDeviceToken(token); if (error) throw new InputError(error); }
      this.camera.stop();
      if (token) this.storage.saveDeviceToken(token);
      if (body.clearToken === true) this.storage.saveDeviceToken(null);
      this.storage.updateSettings(settings => { settings.device.address = normalized; settings.device.autoConnect = false; });
      this.device.configure({ address: normalized, token: this.storage.loadDeviceToken() });
    } else if (path === '/api/device/connect') {
      await validateLanAddress(this.storage.loadSettings().device.address);
      this.device.connect();
    } else if (path === '/api/device/disconnect') { this.device.disconnect(); this.camera.stop(); this.frame = null; }
    else if (path === '/api/settings/canvas') {
      if (this.canvasSync.status().refreshing) throw new InputError('Wait for the current Canvas refresh before changing settings.');
      const url = string(body.baseUrl).trim(), parsed = url ? parseCanvasBaseUrl(url) : null;
      if (parsed && !parsed.ok) throw new InputError(parsed.error);
      const token = string(body.token);
      if (token) { const error = checkApiCredential(token, 'Canvas token'); if (error) throw new InputError(error); this.storage.saveCanvasPersonalToken(token); }
      if (body.clearToken === true) this.storage.saveCanvasPersonalToken(null);
      this.storage.updateSettings(settings => { settings.canvas.baseUrl = parsed?.ok ? parsed.origin : ''; });
      this.canvasSync.start();
    } else if (path === '/api/settings/notion') {
      if (this.notionSync.status().refreshing) throw new InputError('Wait for the current Notion refresh before changing settings.');
      const id = string(body.dataSourceId).trim(), token = string(body.token);
      if (id && !/^[a-f\d-]{32,36}$/i.test(id)) throw new InputError('Enter the Notion data source UUID.');
      if (token) { const error = checkApiCredential(token, 'Notion token'); if (error) throw new InputError(error); this.storage.saveNotionToken(token); }
      if (body.clearToken === true) this.storage.saveNotionToken(null);
      s.notion.dataSourceId = id; this.notionSync.start();
    } else if (path === '/api/sync/canvas') await this.canvasSync.refreshNow();
    else if (path === '/api/sync/notion') await this.notionSync.refreshNow();
    else throw new InputError('Unknown action.');
    this.save();
  }
  async dispose(): Promise<void> { clearInterval(this.tick); this.camera.stop(); this.canvasSync.stop(); this.notionSync.stop(); await this.device.dispose(); }
}
export type AppSnapshot = ReturnType<Application['snapshot']>;
