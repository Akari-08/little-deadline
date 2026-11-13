// TaskPet Link v1. Browser ES module or Node.js 22+. No dependencies.
export const WIDTH = 240;
export const HEIGHT = 320;
export const FRAME_BYTES = WIDTH * HEIGHT * 2;

/** Convert opaque/previously-composited Canvas ImageData RGBA to RGB565LE. */
export function rgbaToRGB565LE(rgba) {
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) ||
      rgba.length !== WIDTH * HEIGHT * 4) {
    throw new RangeError('Expected 240x320 RGBA bytes');
  }
  const result = new Uint8Array(FRAME_BYTES);
  for (let src = 0, dst = 0; src < rgba.length; src += 4, dst += 2) {
    const pixel = ((rgba[src] & 0xf8) << 8) |
                  ((rgba[src + 1] & 0xfc) << 3) | (rgba[src + 2] >> 3);
    result[dst] = pixel & 255;
    result[dst + 1] = pixel >>> 8;
  }
  // Alpha is deliberately ignored. Composite transparency in your app first.
  return result;
}

/** One complete, unfragmented WebSocket message per strip. */
export function encodeFramePackets(rgb565, frameId, stripRows = 16) {
  if (!(rgb565 instanceof Uint8Array) || rgb565.length !== FRAME_BYTES) {
    throw new RangeError('Expected exactly 153600 RGB565LE bytes');
  }
  if (!Number.isInteger(frameId) || frameId < 0 || frameId > 0xffffffff) {
    throw new RangeError('frameId must be uint32');
  }
  if (!Number.isInteger(stripRows) || stripRows < 1 || stripRows > 16) {
    throw new RangeError('stripRows must be 1..16');
  }
  const packets = [];
  for (let y = 0; y < HEIGHT; y += stripRows) {
    const rows = Math.min(stripRows, HEIGHT - y);
    const payloadBytes = rows * WIDTH * 2;
    const packet = new Uint8Array(12 + payloadBytes);
    packet.set([0x54, 0x50, 0x58, 0x31]); // ASCII TPX1
    const header = new DataView(packet.buffer);
    header.setUint32(4, frameId, true);
    header.setUint16(8, y, true);
    header.setUint16(10, rows, true);
    packet.set(rgb565.subarray(y * WIDTH * 2, y * WIDTH * 2 + payloadBytes), 12);
    packets.push(packet);
  }
  return packets;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class TaskPetLink {
  constructor({ url, token, onSensors = () => {}, onStatus = () => {},
                onError = () => {}, timeoutMs = 5000,
                WebSocketClass = globalThis.WebSocket }) {
    const address = new URL(url);
    if (address.protocol !== 'ws:' || address.username || address.password ||
        address.search || address.hash || address.pathname !== '/') {
      throw new Error('Use ws://DEVICE_IP:81/ without credentials or query parameters');
    }
    if (typeof token !== 'string' || token.length < 32 || token.length > 128 ||
        !/^[\x21-\x7e]+$/.test(token)) {
      throw new Error('Use a 32-128 character printable ASCII device token');
    }
    if (!WebSocketClass) throw new Error('WebSocket unavailable; use a browser or Node.js 22+');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100) throw new RangeError('timeoutMs must be >=100');
    this.url = address.href;
    this.token = token;
    this.onSensors = onSensors;
    this.onStatus = onStatus;
    this.onError = onError;
    this.timeoutMs = timeoutMs;
    this.WebSocketClass = WebSocketClass;
    this.socket = null;
    this.ready = false;
    this.info = null;
    this._connecting = null;
    this._pendingConnect = null;
    this._pendingFrame = null;
    this._frameId = 0;
  }

  _notify(callback, value) {
    try { callback(value); } catch (error) {
      if (callback !== this.onError) {
        try { this.onError(error); } catch { /* User callback cannot break transport. */ }
      }
    }
  }

  connect() {
    if (this.ready) return Promise.resolve(this.info);
    if (this._connecting) return this._connecting;
    let resolveConnect, rejectConnect;
    const promise = new Promise((resolve, reject) => {
      resolveConnect = resolve;
      rejectConnect = reject;
    });
    this._connecting = promise;
    this._pendingConnect = { resolve: resolveConnect, reject: rejectConnect,
      timer: setTimeout(() => this._fail(new Error('Connection/authentication timed out')), this.timeoutMs) };
    try {
      const socket = new this.WebSocketClass(this.url, 'arduino');
      this.socket = socket;
      socket.binaryType = 'arraybuffer';
      socket.addEventListener('open', () => {
        if (this.socket === socket) socket.send(`AUTH ${this.token}`);
      });
      socket.addEventListener('message', event => {
        if (this.socket === socket) this._message(event.data);
      });
      socket.addEventListener('error', () => {
        if (this.socket === socket) this._fail(new Error('WebSocket transport error'));
      });
      socket.addEventListener('close', () => {
        if (this.socket === socket) {
          this._fail(new Error('Device disconnected'));
          this._notify(this.onStatus, { type: 'disconnected' });
        }
      });
    } catch {
      this._fail(new Error('Unable to open device WebSocket'));
    }
    return promise;
  }

  _message(data) {
    if (typeof data !== 'string') return this._fail(new Error('Unexpected binary response'));
    let message;
    try { message = JSON.parse(data); } catch {
      return this._fail(new Error('Invalid device JSON'));
    }
    if (!message || typeof message.type !== 'string') return this._fail(new Error('Invalid device message'));
    switch (message.type) {
      case 'hello':
        if (message.protocol !== 'taskpet-link/1') this._fail(new Error('Unsupported device protocol'));
        break;
      case 'ready': {
        if (message.protocol !== 'taskpet-link/1' || message.width !== WIDTH ||
            message.height !== HEIGHT || message.format !== 'rgb565le' ||
            !Number.isInteger(message.max_strip_rows) ||
            message.max_strip_rows < 1 || message.max_strip_rows > 16) {
          this._fail(new Error('Incompatible display configuration'));
          break;
        }
        this.info = message;
        this.ready = true;
        if (this._pendingConnect) {
          clearTimeout(this._pendingConnect.timer);
          this._pendingConnect.resolve(message);
          this._pendingConnect = null;
        }
        this._connecting = null;
        this._notify(this.onStatus, message);
        break;
      }
      case 'sensors':
        if (this.ready) this._notify(this.onSensors, message);
        break;
      case 'frame_ack':
        if (this._pendingFrame && message.frame_id === this._pendingFrame.id) {
          clearTimeout(this._pendingFrame.timer);
          this._pendingFrame.resolve(message);
          this._pendingFrame = null;
        }
        break;
      case 'error':
        // Only a machine error code is reported, never device credentials.
        this._fail(new Error(`Device error: ${String(message.code).replace(/[^a-z0-9_]/gi, '').slice(0, 64)}`));
        break;
      case 'pong': break;
      default: this._fail(new Error('Unknown device message'));
    }
  }

  _fail(error, report = true) {
    this.ready = false;
    this.info = null;
    const socket = this.socket;
    this.socket = null;
    if (this._pendingConnect) {
      clearTimeout(this._pendingConnect.timer);
      this._pendingConnect.reject(error);
      this._pendingConnect = null;
    }
    this._connecting = null;
    if (this._pendingFrame) {
      clearTimeout(this._pendingFrame.timer);
      this._pendingFrame.reject(error);
      this._pendingFrame = null;
    }
    if (socket && socket.readyState < 2) socket.close();
    if (report) this._notify(this.onError, error);
  }

  /** Await completion before sending again. No hidden frame queue. */
  async sendFrame(rgb565) {
    if (!this.ready || !this.socket) throw new Error('Connect before sending frames');
    if (this._pendingFrame) throw new Error('A frame is already in flight');
    const id = this._frameId = (this._frameId + 1) >>> 0;
    const packets = encodeFramePackets(rgb565, id, this.info.max_strip_rows);
    const socket = this.socket;
    let resolveFrame, rejectFrame;
    const ack = new Promise((resolve, reject) => { resolveFrame = resolve; rejectFrame = reject; });
    // Attach immediately: a disconnect may happen while awaiting buffer drain.
    ack.catch(() => {});
    this._pendingFrame = { id, resolve: resolveFrame, reject: rejectFrame,
      timer: setTimeout(() => this._fail(new Error('Frame acknowledgement timed out')), this.timeoutMs) };
    try {
      for (const packet of packets) {
        while (socket.bufferedAmount > 32768) {
          if (this.socket !== socket || socket.readyState !== 1) throw new Error('Device disconnected');
          await sleep(2);
        }
        if (this.socket !== socket || socket.readyState !== 1) throw new Error('Device disconnected');
        socket.send(packet);
      }
      return await ack;
    } catch (error) {
      if (this.socket === socket) this._fail(error);
      throw error;
    }
  }

  async sendRGBA(rgba) { return this.sendFrame(rgbaToRGB565LE(rgba)); }

  /** ctx is a 2D context from your app's exact 240x320 render surface. */
  async sendCanvas(ctx) {
    if (ctx.canvas.width !== WIDTH || ctx.canvas.height !== HEIGHT) {
      throw new RangeError('Canvas backing dimensions must be exactly 240x320');
    }
    return this.sendRGBA(ctx.getImageData(0, 0, WIDTH, HEIGHT).data);
  }

  disconnect() {
    this._fail(new Error('Connection closed by app'), false);
    this._notify(this.onStatus, { type: 'disconnected' });
  }
}
