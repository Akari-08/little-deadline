/**
 * SIMULATED TaskPet Link v1 device — NOT HARDWARE.
 *
 * A local WebSocket peer that mirrors the supplied firmware's protocol rules
 * (TaskPetLink.ino): hello/AUTH/ready, 5 s auth timeout, single owner with `busy`,
 * strip validation (bad_header/bad_strip/frame_in_progress/strip_order), 2 s strip gap
 * (frame_timeout), frame_ack after a complete frame, 20 Hz sensors JSON, PING/pong,
 * and rejection of fragmented messages. Used by tests and for hardware-free development.
 * Its sensor values are synthetic and must always be labeled simulated.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';

const WIDTH = 240, HEIGHT = 320, MAX_STRIP_ROWS = 16;
const FRAME_BYTES = WIDTH * HEIGHT * 2;
/** arduinoWebSockets default WEBSOCKETS_MAX_DATA_SIZE on ESP32 is 15 KiB. */
const MAX_MESSAGE_BYTES = 15 * 1024;

export interface SimulatedDeviceOptions {
  token: string;
  host?: string;
  port?: number;
  environmentKind?: 'BME280' | 'BMP280' | 'none';
  imuPresent?: boolean;
  telemetryIntervalMs?: number;
  /** Simulated TFT transfer time before frame_ack. */
  drawMs?: number;
  authTimeoutMs?: number;
  frameTimeoutMs?: number;
  buttonEnabled?: boolean;
}

export interface SimulatedDeviceStats {
  connections: number;
  authenticated: number;
  authFailures: number;
  busyRejections: number;
  framesCompleted: number;
  completedFrameIds: number[];
  errorsSent: string[];
  /** First strip of every frame attempt: [frameId, y]. A resumed partial frame would show y != 0. */
  frameStarts: Array<[number, number]>;
}

interface Client {
  id: number;
  socket: Duplex;
  buffer: Buffer;
  pendingAuth: boolean;
  authTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  /** Silent dead link: traffic is dropped both ways and ownership is kept until released. */
  blackholed: boolean;
}

export class SimulatedDevice {
  private readonly opts: Required<SimulatedDeviceOptions>;
  private server: Server | null = null;
  private readonly clients = new Set<Client>();
  private nextClientId = 0;
  private owner: Client | null = null;
  private bootAt = Date.now();
  private seq = 0;
  private frameCount = 0;
  private lastFrameId: number | null = null;
  private pressCount = 0;
  private silent = false;
  private imuFault = false;
  private environmentFault = false;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  // Frame staging (like the firmware's PSRAM framebuffer).
  private staging = new Uint8Array(FRAME_BYTES);
  private frameActive = false;
  private receivingId = 0;
  private nextRow = 0;
  private stripTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last completed image (RGB565LE), as the TFT would retain it. */
  displayed: Uint8Array | null = null;
  readonly stats: SimulatedDeviceStats = {
    connections: 0, authenticated: 0, authFailures: 0, busyRejections: 0,
    framesCompleted: 0, completedFrameIds: [], errorsSent: [], frameStarts: [],
  };

  constructor(options: SimulatedDeviceOptions) {
    this.opts = {
      host: '127.0.0.1', port: 0, environmentKind: 'BME280', imuPresent: true,
      telemetryIntervalMs: 50, drawMs: 20, authTimeoutMs: 5000, frameTimeoutMs: 2000,
      buttonEnabled: false, ...options,
    };
    // The app labels loopback peers as simulated. Listening elsewhere would let synthetic
    // readings be mistaken for physical ones, so it is refused.
    if (!/^127\.|^localhost$|^::1$/.test(this.opts.host)) {
      throw new Error('The simulated device only listens on loopback (127.0.0.1/localhost/::1)');
    }
  }

  /** Start listening; resolves with the ws:// URL. */
  async start(): Promise<string> {
    const server = createServer((_request, response) => { response.writeHead(426).end('WebSocket only'); });
    server.on('upgrade', (request, socket) => this.accept(request, socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host, resolve);
    });
    this.server = server;
    this.telemetryTimer = setInterval(() => this.sendSensors(), this.opts.telemetryIntervalMs);
    return this.url;
  }

  get url(): string {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('Simulated device not started');
    return `ws://${this.opts.host}:${address.port}/`;
  }

  get ownerConnected(): boolean { return this.owner !== null; }
  get openConnections(): number { return this.clients.size; }

  async stop(): Promise<void> {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.telemetryTimer = null;
    for (const client of this.clients) this.destroy(client);
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  /** Abruptly drop every TCP connection (simulates Wi-Fi loss) without a close frame. */
  dropConnections(): void {
    for (const client of this.clients) this.destroy(client);
  }

  /** Drop connections and reset device uptime/counters, like a power cycle. */
  reboot(): void {
    this.dropConnections();
    this.bootAt = Date.now();
    this.seq = 0;
    this.frameCount = 0;
    this.lastFrameId = null;
    this.pressCount = 0;
    this.displayed = null; // a reboot does not retain the image
  }

  /** Stop/resume telemetry while keeping the socket open (simulates a frozen device). */
  setSilent(silent: boolean): void { this.silent = silent; }

  /**
   * Simulate a silent Wi-Fi loss: the app's traffic is dropped, nothing is sent back, and the
   * device keeps the dead socket as owner (so new connections get `busy`) until its heartbeat
   * would notice - here after `releaseAfterMs` (the firmware takes roughly 16-26 s).
   */
  blackhole(releaseAfterMs: number): void {
    const owner = this.owner;
    if (!owner) return;
    owner.blackholed = true;
    setTimeout(() => {
      owner.blackholed = false;
      this.destroy(owner);
    }, releaseAfterMs).unref();
  }

  /**
   * Sensor faults as the firmware reports them after a sensor stops responding:
   * IMU `present:true, valid:false`; environment `kind` kept with `valid:false`.
   */
  setSensorFaults(faults: { imu?: boolean; environment?: boolean }): void {
    if (faults.imu !== undefined) this.imuFault = faults.imu;
    if (faults.environment !== undefined) this.environmentFault = faults.environment;
  }

  /** Send a device error to the current owner (e.g. `strip_order`), as the firmware would. */
  injectError(code: string): void {
    if (this.owner) this.sendError(this.owner, code);
  }

  pressButton(): void { if (this.opts.buttonEnabled) this.pressCount = (this.pressCount + 1) >>> 0; }

  // --- WebSocket server plumbing ------------------------------------------------

  private accept(request: IncomingMessage, socket: Duplex): void {
    const key = request.headers['sec-websocket-key'];
    const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(p => p.trim());
    if (typeof key !== 'string' || !protocols.includes('arduino') || (request.url ?? '/') !== '/') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: arduino\r\n\r\n`);
    const client: Client = { id: ++this.nextClientId, socket, buffer: Buffer.alloc(0), pendingAuth: false, authTimer: null, closed: false, blackholed: false };
    this.clients.add(client);
    this.stats.connections += 1;
    socket.on('data', chunk => this.onData(client, chunk as Buffer));
    socket.on('close', () => this.onClosed(client));
    socket.on('error', () => this.onClosed(client));

    // Firmware WStype_CONNECTED
    if (this.owner) {
      this.stats.busyRejections += 1;
      this.sendError(client, 'busy');
      this.close(client);
      return;
    }
    client.pendingAuth = true;
    client.authTimer = setTimeout(() => { if (client.pendingAuth) this.close(client); }, this.opts.authTimeoutMs);
    this.sendText(client, { type: 'hello', protocol: 'taskpet-link/1', auth_required: true });
  }

  private onData(client: Client, chunk: Buffer): void {
    if (client.closed || client.blackholed) return;
    client.buffer = Buffer.concat([client.buffer, chunk]);
    while (client.buffer.length >= 2) {
      const b0 = client.buffer[0]!, b1 = client.buffer[1]!;
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f, offset = 2;
      if (length === 126) {
        if (client.buffer.length < 4) return;
        length = client.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (client.buffer.length < 10) return;
        const big = client.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) return this.destroy(client); // oversized: close without JSON
        length = Number(big); offset = 10;
      }
      if (!masked || length > MAX_MESSAGE_BYTES) return this.destroy(client);
      if (client.buffer.length < offset + 4 + length) return;
      const mask = client.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(client.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
      client.buffer = client.buffer.subarray(offset + 4 + length);

      if (opcode === 0x8) return this.close(client);
      if (opcode === 0x9) { this.writeFrame(client, 0xa, payload); continue; }
      if (opcode === 0xa) continue;
      if (!fin || opcode === 0x0) {
        this.resetFrame();
        this.sendError(client, 'fragmented_message_unsupported');
        return this.close(client);
      }
      if (opcode === 0x1) this.onText(client, payload);
      else if (opcode === 0x2) this.onBinary(client, payload);
      if (client.closed) return;
    }
  }

  private onText(client: Client, payload: Buffer): void {
    if (this.owner !== client) {
      const token = Buffer.from(this.opts.token);
      const expected = Buffer.concat([Buffer.from('AUTH '), token]);
      if (this.owner || !client.pendingAuth || !payload.equals(expected)) {
        this.stats.authFailures += 1;
        this.sendError(client, 'auth_failed');
        return this.close(client);
      }
      this.owner = client;
      client.pendingAuth = false;
      if (client.authTimer) clearTimeout(client.authTimer);
      this.stats.authenticated += 1;
      this.sendText(client, {
        type: 'ready', protocol: 'taskpet-link/1', width: WIDTH, height: HEIGHT, format: 'rgb565le',
        max_strip_rows: MAX_STRIP_ROWS, telemetry_hz: 20, button_enabled: this.opts.buttonEnabled,
      });
      this.sendSensors();
    } else if (payload.toString() === 'PING') {
      this.sendText(client, { type: 'pong' });
    } else {
      this.sendError(client, 'unknown_command');
    }
  }

  private onBinary(client: Client, data: Buffer): void {
    if (this.owner !== client) {
      this.sendError(client, 'auth_required');
      return this.close(client);
    }
    if (data.length < 12 || data.toString('latin1', 0, 4) !== 'TPX1') return this.frameError(client, 'bad_header');
    const id = data.readUInt32LE(4), y = data.readUInt16LE(8), rows = data.readUInt16LE(10);
    if (rows === 0 || rows > MAX_STRIP_ROWS || y >= HEIGHT || y + rows > HEIGHT || data.length !== 12 + rows * WIDTH * 2) {
      return this.frameError(client, 'bad_strip');
    }
    if (y === 0) {
      if (this.frameActive) return this.frameError(client, 'frame_in_progress');
      this.frameActive = true; this.receivingId = id; this.nextRow = 0;
    }
    if (this.nextRow === 0) this.stats.frameStarts.push([id, y]);
    if (!this.frameActive || id !== this.receivingId || y !== this.nextRow) return this.frameError(client, 'strip_order');
    this.staging.set(data.subarray(12), y * WIDTH * 2);
    this.nextRow += rows;
    this.armStripTimer();
    if (this.nextRow === HEIGHT) {
      const image = this.staging.slice();
      this.resetFrame();
      setTimeout(() => {
        if (client.closed) return;
        this.displayed = image;
        this.lastFrameId = id;
        this.frameCount = (this.frameCount + 1) >>> 0;
        this.stats.framesCompleted += 1;
        this.stats.completedFrameIds.push(id);
        this.sendText(client, { type: 'frame_ack', frame_id: id, frames: this.frameCount, draw_ms: this.opts.drawMs, uptime_ms: this.uptime() });
      }, this.opts.drawMs);
    }
  }

  private frameError(client: Client, code: string): void {
    this.resetFrame();
    this.sendError(client, code);
  }

  private armStripTimer(): void {
    if (this.stripTimer) clearTimeout(this.stripTimer);
    this.stripTimer = setTimeout(() => {
      if (!this.frameActive) return;
      this.resetFrame();
      if (this.owner) this.sendError(this.owner, 'frame_timeout');
    }, this.opts.frameTimeoutMs);
  }

  private resetFrame(): void {
    this.frameActive = false;
    this.nextRow = 0;
    if (this.stripTimer) clearTimeout(this.stripTimer);
    this.stripTimer = null;
  }

  private uptime(): number { return (Date.now() - this.bootAt) >>> 0; }

  private sendSensors(): void {
    const owner = this.owner;
    if (!owner || this.silent) return;
    const now = this.uptime();
    const t = now / 1000;
    const imuPresent = this.opts.imuPresent;
    const imuValid = imuPresent && !this.imuFault;
    const env = this.opts.environmentKind;
    const envValid = env !== 'none' && !this.environmentFault;
    const envSample = envValid ? now - (now % 1000) : null; // 1 Hz environment samples
    const roll = 8 * Math.sin(t / 3), pitch = 5 * Math.cos(t / 4);
    const g = 9.80665, rad = Math.PI / 180;
    const round = (value: number) => Math.round(value * 1000) / 1000;
    this.sendText(owner, {
      type: 'sensors', seq: (this.seq = (this.seq + 1) >>> 0), uptime_ms: now,
      imu: {
        present: imuPresent, valid: imuValid, sample_ms: imuValid ? now : null,
        accel_m_s2: imuValid ? [round(-g * Math.sin(pitch * rad)), round(g * Math.sin(roll * rad)), round(g * Math.cos(roll * rad))] : [null, null, null],
        gyro_rad_s: imuValid ? [round(0.01 * Math.sin(t)), 0, 0] : [null, null, null],
        temperature_c: imuValid ? 28 : null,
        roll_deg: imuValid ? round(roll) : null, pitch_deg: imuValid ? round(pitch) : null,
      },
      environment: {
        kind: env, valid: envValid, sample_ms: envSample,
        temperature_c: envValid ? round(22 + Math.sin(t / 60)) : null,
        pressure_hpa: envValid ? 1009.5 : null,
        humidity_pct: envValid && env === 'BME280' ? 45 : null,
      },
      button: { enabled: this.opts.buttonEnabled, pressed: false, press_count: this.pressCount },
      display: { frames: this.frameCount, last_frame_id: this.lastFrameId },
      rssi_dbm: -55,
    });
  }

  private sendError(client: Client, code: string): void {
    this.stats.errorsSent.push(code);
    this.sendText(client, { type: 'error', code });
  }

  private sendText(client: Client, message: object): void {
    this.writeFrame(client, 0x1, Buffer.from(JSON.stringify(message)));
  }

  private writeFrame(client: Client, opcode: number, payload: Buffer): void {
    if (client.closed || client.blackholed) return;
    const header = payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
    client.socket.write(Buffer.concat([header, payload]));
  }

  /** Graceful close (close frame, then end), like WebSocketsServer::disconnect. */
  private close(client: Client): void {
    if (client.closed) return;
    this.writeFrame(client, 0x8, Buffer.alloc(0));
    client.socket.end();
    this.onClosed(client);
    setTimeout(() => client.socket.destroy(), 200).unref();
  }

  private destroy(client: Client): void {
    client.socket.destroy();
    this.onClosed(client);
  }

  private onClosed(client: Client): void {
    // A blackholed owner is kept until its simulated heartbeat timeout releases it.
    if (client.closed || client.blackholed) return;
    client.closed = true;
    if (client.authTimer) clearTimeout(client.authTimer);
    this.clients.delete(client);
    if (this.owner === client) {
      this.owner = null;
      this.resetFrame(); // last completed image retained
    }
  }
}
