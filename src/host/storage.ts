/**
 * Local persistence. Ordinary settings and secrets live in SEPARATE files in a per-user
 * data directory outside the repository (so they cannot be committed by accident):
 *   Windows: %APPDATA%\TaskPet     macOS: ~/Library/Application Support/TaskPet
 *   Linux:   $XDG_CONFIG_HOME/taskpet or ~/.config/taskpet
 * Override with TASKPET_DATA_DIR. Files are versioned; a corrupt settings file is set aside
 * and replaced with defaults; a corrupt secrets file is deleted (no stray credential copies).
 *
 * Secrets held here (host process only — never sent to UI code, the ESP32, logs or URLs):
 * the ESP32 device token, a Canvas LMS personal access token, Canvas OAuth2 tokens, and a
 * Canvas OAuth2 client secret.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkDeviceToken } from '../device/token.ts';
import { DEFAULT_TARGET_FPS, MAX_TARGET_FPS, MIN_TARGET_FPS } from '../device/streamer.ts';

export const SETTINGS_SCHEMA_VERSION = 1;
export const SECRETS_SCHEMA_VERSION = 1;

export type CanvasAuthMode = 'personal-token' | 'oauth2';

export interface AppSettings {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  device: {
    /** IP, taskpet-xxxxxx.local, or ws://host:81/. Not a secret. */
    address: string;
    /** Reconnect automatically when the app starts. */
    autoConnect: boolean;
  };
  streaming: { targetFps: number };
  /** Canvas LMS (coursework) — unrelated to the Canvas 2D render surface. */
  canvas: {
    /** Institution origin, e.g. https://canvas.example.edu ('' = unconfigured). */
    baseUrl: string;
    authMode: CanvasAuthMode;
    /** OAuth2 developer key client ID issued by the institution ('' = not available). */
    oauthClientId: string;
    /**
     * Port of the loopback redirect URI registered on the developer key
     * (http://127.0.0.1:<port>/oauth/callback). Sign-in and refresh must use the same one.
     */
    oauthRedirectPort: number;
    /** Fetch window around today. */
    lookbackDays: number;
    lookaheadDays: number;
    /** Background refresh period. */
    refreshMinutes: number;
  };
}

/** Canvas OAuth2 tokens for the signed-in user. */
export interface CanvasOAuthTokens {
  accessToken: string;
  /** Long-lived; used to obtain new access tokens (Canvas access tokens last ~1 h). */
  refreshToken: string | null;
  /** ISO 8601 UTC expiry of accessToken, or null if unknown. */
  expiresAt: string | null;
  /** Canvas user id the tokens belong to (not a secret, kept for display/consistency). */
  userId: string | null;
}

export interface Secrets {
  schemaVersion: typeof SECRETS_SCHEMA_VERSION;
  deviceToken: string | null;
  canvasPersonalToken: string | null;
  canvasOAuth: CanvasOAuthTokens | null;
  canvasOAuthClientSecret: string | null;
}

/** Safe-to-display secret presence flags. Never contains secret values. */
export interface SecretsSummary {
  deviceTokenSet: boolean;
  canvasPersonalTokenSet: boolean;
  canvasSignedIn: boolean;
  canvasClientSecretSet: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  device: { address: '', autoConnect: false },
  streaming: { targetFps: DEFAULT_TARGET_FPS },
  canvas: { baseUrl: '', authMode: 'personal-token', oauthClientId: '', oauthRedirectPort: 51735, lookbackDays: 7, lookaheadDays: 21, refreshMinutes: 15 },
};

const EMPTY_SECRETS: Secrets = {
  schemaVersion: SECRETS_SCHEMA_VERSION,
  deviceToken: null, canvasPersonalToken: null, canvasOAuth: null, canvasOAuthClientSecret: null,
};

export function defaultDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.TASKPET_DATA_DIR) return env.TASKPET_DATA_DIR;
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'TaskPet');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'TaskPet');
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'taskpet');
}

const isObj = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clampInt = (value: unknown, lo: number, hi: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(hi, Math.max(lo, Math.round(value))) : fallback;

/** A credential-like string: printable ASCII, no spaces, bounded length. */
export function checkApiCredential(value: string, label: string): string | null {
  if (value.length < 8 || value.length > 512) return `${label} must be 8–512 characters`;
  if (!/^[\x21-\x7e]+$/.test(value)) return `${label} must be printable ASCII with no spaces`;
  return null;
}

/** Sanitize any parsed JSON into valid settings, keeping valid fields and defaulting the rest. */
export function normalizeSettings(raw: unknown): AppSettings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  if (!isObj(raw)) return settings;
  // Future migrations: switch on raw.schemaVersion here before reading fields.
  if (isObj(raw.device)) {
    if (typeof raw.device.address === 'string') settings.device.address = raw.device.address.trim().slice(0, 300);
    if (typeof raw.device.autoConnect === 'boolean') settings.device.autoConnect = raw.device.autoConnect;
  }
  if (isObj(raw.streaming)) {
    const fps = raw.streaming.targetFps;
    if (typeof fps === 'number' && Number.isFinite(fps)) {
      settings.streaming.targetFps = Math.min(MAX_TARGET_FPS, Math.max(MIN_TARGET_FPS, fps));
    }
  }
  if (isObj(raw.canvas)) {
    const c = raw.canvas, d = DEFAULT_SETTINGS.canvas;
    if (typeof c.baseUrl === 'string') settings.canvas.baseUrl = c.baseUrl.trim().slice(0, 300);
    if (c.authMode === 'personal-token' || c.authMode === 'oauth2') settings.canvas.authMode = c.authMode;
    if (typeof c.oauthClientId === 'string') settings.canvas.oauthClientId = c.oauthClientId.trim().slice(0, 200);
    if (typeof c.oauthRedirectPort === 'number' && Number.isInteger(c.oauthRedirectPort) && c.oauthRedirectPort >= 1024 && c.oauthRedirectPort <= 65535) {
      settings.canvas.oauthRedirectPort = c.oauthRedirectPort;
    }
    settings.canvas.lookbackDays = clampInt(c.lookbackDays, 0, 60, d.lookbackDays);
    settings.canvas.lookaheadDays = clampInt(c.lookaheadDays, 1, 120, d.lookaheadDays);
    settings.canvas.refreshMinutes = clampInt(c.refreshMinutes, 5, 240, d.refreshMinutes);
  }
  return settings;
}

function normalizeSecrets(raw: unknown): Secrets {
  const secrets = structuredClone(EMPTY_SECRETS);
  if (!isObj(raw)) return secrets;
  const str = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);
  secrets.deviceToken = str(raw.deviceToken);
  secrets.canvasPersonalToken = str(raw.canvasPersonalToken);
  secrets.canvasOAuthClientSecret = str(raw.canvasOAuthClientSecret);
  if (isObj(raw.canvasOAuth) && str(raw.canvasOAuth.accessToken)) {
    secrets.canvasOAuth = {
      accessToken: raw.canvasOAuth.accessToken as string,
      refreshToken: str(raw.canvasOAuth.refreshToken),
      expiresAt: str(raw.canvasOAuth.expiresAt),
      userId: str(raw.canvasOAuth.userId),
    };
  }
  return secrets;
}

export class AppStorage {
  readonly dir: string;
  readonly warnings: string[] = [];

  constructor(dir: string = defaultDataDir()) {
    this.dir = dir;
  }

  get settingsPath(): string { return join(this.dir, 'settings.json'); }
  get secretsPath(): string { return join(this.dir, 'secrets.json'); }
  /** Task/pet data: ordinary app state, kept apart from settings and secrets. */
  get tasksPath(): string { return join(this.dir, 'tasks.json'); }

  /** Raw parsed tasks file (validated by TaskStore), or null if absent/corrupt. */
  loadTasksFile(): unknown {
    return this.readJson(this.tasksPath, Number.MAX_SAFE_INTEGER);
  }

  saveTasksFile(value: unknown): void {
    this.writeJson(this.tasksPath, value, 0o644);
  }

  loadSettings(): AppSettings {
    return normalizeSettings(this.readJson(this.settingsPath, SETTINGS_SCHEMA_VERSION));
  }

  saveSettings(settings: AppSettings): void {
    this.writeJson(this.settingsPath, normalizeSettings(settings), 0o644);
  }

  updateSettings(change: (settings: AppSettings) => void): AppSettings {
    const settings = this.loadSettings();
    change(settings);
    this.saveSettings(settings);
    return this.loadSettings();
  }

  // --- ESP32 device token --------------------------------------------------------

  /** The device token for the connection owner only. Never send this to UI code. */
  loadDeviceToken(): string | null {
    const token = this.loadSecrets().deviceToken;
    if (token !== null && checkDeviceToken(token)) {
      this.warnings.push('Stored device token is not valid; please enter it again.');
      return null;
    }
    return token;
  }

  /** Store (or clear with null) the device token. Throws a token-free message if invalid. */
  saveDeviceToken(token: string | null): void {
    if (token !== null) {
      const problem = checkDeviceToken(token);
      if (problem) throw new Error(problem);
    }
    this.updateSecrets(secrets => { secrets.deviceToken = token; });
  }

  // --- Canvas LMS credentials (host-side only) -----------------------------------

  loadCanvasPersonalToken(): string | null { return this.loadSecrets().canvasPersonalToken; }

  saveCanvasPersonalToken(token: string | null): void {
    if (token !== null) {
      const problem = checkApiCredential(token, 'The Canvas access token');
      if (problem) throw new Error(problem);
    }
    this.updateSecrets(secrets => { secrets.canvasPersonalToken = token; });
  }

  loadCanvasOAuthTokens(): CanvasOAuthTokens | null { return this.loadSecrets().canvasOAuth; }

  saveCanvasOAuthTokens(tokens: CanvasOAuthTokens | null): void {
    this.updateSecrets(secrets => { secrets.canvasOAuth = tokens ? { ...tokens } : null; });
  }

  loadCanvasOAuthClientSecret(): string | null { return this.loadSecrets().canvasOAuthClientSecret; }

  saveCanvasOAuthClientSecret(secret: string | null): void {
    if (secret !== null) {
      const problem = checkApiCredential(secret, 'The OAuth client secret');
      if (problem) throw new Error(problem);
    }
    this.updateSecrets(secrets => { secrets.canvasOAuthClientSecret = secret; });
  }

  /** Safe for display: which secrets are present, never their values. */
  describeSecrets(): SecretsSummary {
    const secrets = this.loadSecrets();
    return {
      deviceTokenSet: this.loadDeviceToken() !== null,
      canvasPersonalTokenSet: secrets.canvasPersonalToken !== null,
      canvasSignedIn: secrets.canvasOAuth !== null,
      canvasClientSecretSet: secrets.canvasOAuthClientSecret !== null,
    };
  }

  // ---------------------------------------------------------------------------

  private loadSecrets(): Secrets {
    this.removeStaleTempFiles('secrets.json');
    // A corrupt secrets file is deleted, not set aside, so no extra copy of a credential lingers.
    return normalizeSecrets(this.readJson(this.secretsPath, SECRETS_SCHEMA_VERSION, { keepCorrupt: false }));
  }

  private updateSecrets(change: (secrets: Secrets) => void): void {
    const secrets = this.loadSecrets();
    change(secrets);
    this.writeJson(this.secretsPath, secrets, 0o600);
  }

  private readJson(path: string, supportedVersion: number, { keepCorrupt = true } = {}): unknown {
    if (!existsSync(path)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      if (!keepCorrupt) {
        try { rmSync(path, { force: true }); } catch { /* leave it */ }
        this.warnings.push(`${path} was unreadable and has been removed; please enter your tokens again.`);
        return null;
      }
      const aside = `${path}.corrupt-${Date.now()}`;
      try { renameSync(path, aside); } catch { /* leave it */ }
      this.warnings.push(`${path} was unreadable; moved to ${aside} and using defaults.`);
      return null;
    }
    const version = isObj(parsed) ? parsed.schemaVersion : undefined;
    if (typeof version === 'number' && version > supportedVersion) {
      this.warnings.push(`${path} was written by a newer TaskPet (schema ${version}); reading known fields only.`);
    }
    return parsed;
  }

  private writeJson(path: string, value: unknown, mode: number): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}`;
    try {
      writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
      renameSync(temp, path); // atomic replace: never leaves a half-written file
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  /** Remove temp files a crash may have left mid-write (they can contain credentials). */
  private removeStaleTempFiles(baseName: string): void {
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      if (name.startsWith(`${baseName}.tmp-`)) rmSync(join(this.dir, name), { force: true });
    }
  }
}
