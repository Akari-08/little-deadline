// Type declarations for the vendored TaskPet Link v1 connector (taskpet-link.mjs).
// Types only: the runtime behavior lives unchanged in taskpet-link.mjs.

export declare const WIDTH: 240;
export declare const HEIGHT: 320;
export declare const FRAME_BYTES: 153600;

/** `ready` message as validated by the connector (protocol, 240x320, rgb565le, 1..16 strip rows). */
export interface ReadyMessage {
  type: 'ready';
  protocol: 'taskpet-link/1';
  width: 240;
  height: 320;
  format: 'rgb565le';
  max_strip_rows: number;
  /** Not validated by the connector; validate before use. */
  telemetry_hz?: unknown;
  /** Not validated by the connector; validate before use. */
  button_enabled?: unknown;
}

/** `frame_ack` message. Only `frame_id` is checked (it matched the outstanding frame). */
export interface FrameAckMessage {
  type: 'frame_ack';
  frame_id: number;
  frames?: unknown;
  draw_ms?: unknown;
  uptime_ms?: unknown;
}

export type LinkStatus = ReadyMessage | { type: 'disconnected' };

/** Minimal WebSocket constructor shape the connector uses. */
export type WebSocketConstructor = new (url: string, protocol: string) => unknown;

export interface TaskPetLinkOptions {
  url: string;
  token: string;
  /** Raw `sensors` JSON object; unvalidated beyond `type`. */
  onSensors?: (sample: { type: 'sensors' } & Record<string, unknown>) => void;
  onStatus?: (status: LinkStatus) => void;
  onError?: (error: Error) => void;
  timeoutMs?: number;
  WebSocketClass?: WebSocketConstructor;
}

export declare function rgbaToRGB565LE(rgba: Uint8Array | Uint8ClampedArray): Uint8Array;
export declare function encodeFramePackets(rgb565: Uint8Array, frameId: number, stripRows?: number): Uint8Array[];

export declare class TaskPetLink {
  constructor(options: TaskPetLinkOptions);
  readonly url: string;
  readonly ready: boolean;
  readonly info: ReadyMessage | null;
  connect(): Promise<ReadyMessage>;
  sendFrame(rgb565: Uint8Array): Promise<FrameAckMessage>;
  sendRGBA(rgba: Uint8Array | Uint8ClampedArray): Promise<FrameAckMessage>;
  sendCanvas(ctx: {
    canvas: { width: number; height: number };
    getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
  }): Promise<FrameAckMessage>;
  disconnect(): void;
}
