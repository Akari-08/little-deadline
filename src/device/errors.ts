/**
 * Classifies TaskPet Link failures so the supervisor knows whether to retry.
 * The connector reports device errors as `Device error: <code>`; transport and
 * timeout failures use fixed messages (see device-link/taskpet-link.mjs).
 */
import { redactToken } from './token.ts';

export type FailureKind =
  | 'auth'      // wrong/missing token: stop automatic retries
  | 'config'    // bad address/token format or incompatible device: stop automatic retries
  | 'busy'      // another authenticated app owns the device: never fight it
  | 'protocol'  // device rejected our strips/commands: reconnect, send the newest frame
  | 'timeout'   // connect/auth or frame ACK timed out
  | 'stalled'   // connection open but no telemetry/ACKs for too long
  | 'transport'; // socket error/close

export interface LinkFailure {
  kind: FailureKind;
  /** Device error code such as `bad_strip`, when the device sent one. */
  code: string | null;
  /** User-facing explanation. Never contains the device token. */
  message: string;
}

const PROTOCOL_CODES = new Set([
  'bad_header', 'bad_strip', 'frame_in_progress', 'strip_order', 'frame_timeout',
  'unknown_command', 'fragmented_message_unsupported',
]);

export class StalledLinkError extends Error {
  constructor(silentMs: number) {
    super(`No telemetry or frame acknowledgements for ${Math.round(silentMs / 1000)} s`);
    this.name = 'StalledLinkError';
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function stopsAutomaticRetry(kind: FailureKind): boolean {
  return kind === 'auth' || kind === 'config';
}

export function classifyLinkError(error: unknown, token: string | null = null): LinkFailure {
  const raw = redactToken(error instanceof Error ? error.message : String(error), token).slice(0, 300);
  if (error instanceof ConfigError) return { kind: 'config', code: null, message: raw };
  if (error instanceof StalledLinkError) {
    return { kind: 'stalled', code: null, message: `${raw}; the device may be off, out of Wi-Fi range, or frozen. Reconnecting.` };
  }

  const deviceCode = /^Device error: ([a-z0-9_]{1,64})$/i.exec(raw)?.[1] ?? null;
  if (deviceCode) {
    if (deviceCode === 'auth_required') {
      return { kind: 'protocol', code: deviceCode, message: 'The device received pixels before authentication (app bug). Reconnecting.' };
    }
    if (deviceCode === 'auth_failed') {
      return {
        kind: 'auth', code: deviceCode,
        message: 'The device rejected the token. Check that it exactly matches LINK_DEVICE_TOKEN in the firmware secrets.h. Automatic retries are paused until you change settings or retry.',
      };
    }
    if (deviceCode === 'busy') {
      return { kind: 'busy', code: deviceCode, message: 'The device is busy: another app is already connected to it. TaskPet will not take over its connection.' };
    }
    if (PROTOCOL_CODES.has(deviceCode)) {
      return { kind: 'protocol', code: deviceCode, message: `The device rejected a frame (${deviceCode}). Reconnecting and sending the newest frame.` };
    }
    return { kind: 'protocol', code: deviceCode, message: `Device error: ${deviceCode}` };
  }

  if (/^(Incompatible display configuration|Unsupported device protocol)$/.test(raw)) {
    return { kind: 'config', code: null, message: `${raw}. This device does not speak TaskPet Link v1 with a 240x320 RGB565 display.` };
  }
  if (/^Use (ws:\/\/|a 32-128)/.test(raw)) return { kind: 'config', code: null, message: raw };
  if (raw === 'Connection/authentication timed out') {
    return { kind: 'timeout', code: null, message: 'Could not reach and authenticate with the device within 5 s. Check that it is powered, on the same network, and that the address is right (if a .local name does not resolve, use the IP).' };
  }
  if (raw === 'Frame acknowledgement timed out') {
    return { kind: 'timeout', code: null, message: 'The device did not acknowledge a frame within 5 s. Reconnecting.' };
  }
  if (/^Invalid device (JSON|message)$|^Unknown device message$|^Unexpected binary response$/.test(raw)) {
    return { kind: 'protocol', code: null, message: `${raw}. Reconnecting.` };
  }
  return { kind: 'transport', code: null, message: raw || 'Connection lost' };
}
