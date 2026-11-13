/**
 * Thin typed adapter over the vendored TaskPet Link connector. The connector does
 * the wire work (auth, RGB565 strips, ACK matching, timeouts); this file only
 * narrows its API and validates the loosely-typed fields it passes through.
 */
import { TaskPetLink, rgbaToRGB565LE, FRAME_BYTES, WIDTH, HEIGHT } from '../../device-link/taskpet-link.mjs';
import type { FrameAckMessage, LinkStatus, ReadyMessage } from '../../device-link/taskpet-link.mjs';

export { rgbaToRGB565LE, FRAME_BYTES, WIDTH, HEIGHT };
export type { FrameAckMessage, LinkStatus, ReadyMessage };

/** What the supervisor needs from one connection attempt. One instance = one socket. */
export interface DeviceLink {
  connect(): Promise<ReadyMessage>;
  sendFrame(rgb565: Uint8Array): Promise<FrameAckMessage>;
  disconnect(): void;
}

export interface LinkOptions {
  url: string;
  token: string;
  timeoutMs: number;
  onSensors(raw: unknown): void;
  onError(error: Error): void;
  /**
   * Called synchronously when `ready` arrives, before any telemetry from that session and
   * before the connect() promise continuation runs.
   */
  onStatus(status: LinkStatus): void;
}

export type LinkFactory = (options: LinkOptions) => DeviceLink;

export const createTaskPetLink: LinkFactory = options => new TaskPetLink(options);

export interface ReadyInfo {
  protocol: 'taskpet-link/1';
  width: 240;
  height: 320;
  format: 'rgb565le';
  maxStripRows: number;
  /** Nominal telemetry rate the device advertised; not a guarantee. */
  telemetryHz: number | null;
  /** Whether the GPIO13 button is enabled in firmware (false in the supplied firmware). */
  buttonEnabled: boolean | null;
}

export function toReadyInfo(message: ReadyMessage): ReadyInfo {
  const hz = message.telemetry_hz;
  return {
    protocol: message.protocol,
    width: message.width,
    height: message.height,
    format: message.format,
    maxStripRows: message.max_strip_rows,
    telemetryHz: typeof hz === 'number' && Number.isFinite(hz) && hz > 0 && hz <= 1000 ? hz : null,
    buttonEnabled: typeof message.button_enabled === 'boolean' ? message.button_enabled : null,
  };
}

export interface FrameAck {
  frameId: number;
  /** Frames completed since device boot (wraps modulo 2^32). */
  deviceFrames: number | null;
  /** Device TFT transfer time only, not end-to-end latency. */
  drawMs: number | null;
  uptimeMs: number | null;
}

const isUint32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

export function toFrameAck(message: FrameAckMessage): FrameAck {
  return {
    frameId: message.frame_id,
    deviceFrames: isUint32(message.frames) ? message.frames : null,
    drawMs: isUint32(message.draw_ms) && message.draw_ms < 60_000 ? message.draw_ms : null,
    uptimeMs: isUint32(message.uptime_ms) ? message.uptime_ms : null,
  };
}
