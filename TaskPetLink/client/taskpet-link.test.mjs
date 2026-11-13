import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskPetLink, rgbaToRGB565LE, encodeFramePackets, FRAME_BYTES } from './taskpet-link.mjs';

const token = 'test-only-device-token-not-a-real-secret';
const info = { type: 'ready', protocol: 'taskpet-link/1', width: 240, height: 320,
  format: 'rgb565le', max_strip_rows: 16 };

class FakeSocket {
  static instances = [];
  static replyAuth = true;
  static replyFrame = true;
  constructor() {
    this.readyState = 0; this.bufferedAmount = 0; this.listeners = {}; this.sent = [];
    FakeSocket.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); });
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  emit(type, event) { for (const fn of this.listeners[type] ?? []) fn(event); }
  message(value) { this.emit('message', { data: JSON.stringify(value) }); }
  send(data) {
    this.sent.push(data);
    if (typeof data === 'string') {
      assert.equal(data, `AUTH ${token}`);
      if (FakeSocket.replyAuth) queueMicrotask(() => this.message(info));
    } else if (FakeSocket.replyFrame) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (view.getUint16(8, true) + view.getUint16(10, true) === 320) {
        queueMicrotask(() => this.message({ type: 'frame_ack', frame_id: view.getUint32(4, true) }));
      }
    }
  }
  close() { this.readyState = 3; this.emit('close', {}); }
}
function makeLink(options = {}) {
  FakeSocket.replyAuth = true; FakeSocket.replyFrame = true;
  return new TaskPetLink({ url: 'ws://192.0.2.1:81/', token, WebSocketClass: FakeSocket, ...options });
}

test('primary RGB colors encode to the protocol little-endian golden values', () => {
  const rgba = new Uint8ClampedArray(240 * 320 * 4);
  rgba.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  assert.deepEqual([...rgbaToRGB565LE(rgba).slice(0, 8)], [0x00, 0xf8, 0xe0, 0x07, 0x1f, 0x00, 0xff, 0xff]);
});
test('packet headers, complete row coverage, and arbitrary binary data survive transport encoding', () => {
  const pixels = Uint8Array.from({ length: FRAME_BYTES }, (_, i) => i % 256);
  const packets = encodeFramePackets(pixels, 0x12345678);
  assert.equal(packets.length, 20);
  assert.deepEqual([...packets[0].slice(0, 12)], [0x54,0x50,0x58,0x31,0x78,0x56,0x34,0x12,0,0,16,0]);
  assert.deepEqual([...packets[19].slice(8, 12)], [0x30,0x01,16,0]);
  const reconstructed = new Uint8Array(FRAME_BYTES);
  for (let i = 0; i < packets.length; ++i) reconstructed.set(packets[i].subarray(12), i * 7680);
  assert.deepEqual(reconstructed, pixels);
  assert.equal(encodeFramePackets(pixels, 1, 3).at(-1).length, 12 + 2 * 240 * 2);
});
test('rejects incompatible frame dimensions and header bounds', () => {
  assert.throws(() => rgbaToRGB565LE(new Uint8Array(4)), RangeError);
  assert.throws(() => encodeFramePackets(new Uint8Array(10), 1), RangeError);
  assert.throws(() => encodeFramePackets(new Uint8Array(FRAME_BYTES), -1), RangeError);
  assert.throws(() => encodeFramePackets(new Uint8Array(FRAME_BYTES), 1, 17), RangeError);
});
test('authentication, sensor delivery, and frame acknowledgement use the same socket', async () => {
  const sensors = []; const link = makeLink({ onSensors: value => sensors.push(value) });
  try {
    assert.equal((await link.connect()).format, 'rgb565le');
    link.socket.message({ type: 'sensors', imu: { valid: false, accel_m_s2: [null, null, null] } });
    assert.equal(sensors.length, 1);
    const ack = await link.sendFrame(new Uint8Array(FRAME_BYTES));
    assert.equal(ack.frame_id, 1);
    assert.equal(link.socket.sent.filter(x => x instanceof Uint8Array).length, 20);
  } finally { link.disconnect(); }
});
test('a second frame is rejected while one is outstanding; unrelated ACK cannot release it', async () => {
  const link = makeLink();
  try {
    await link.connect(); FakeSocket.replyFrame = false;
    const pending = link.sendFrame(new Uint8Array(FRAME_BYTES));
    await assert.rejects(link.sendFrame(new Uint8Array(FRAME_BYTES)), /already in flight/);
    link.socket.message({ type: 'frame_ack', frame_id: 99 });
    assert.ok(link._pendingFrame);
    link.socket.message({ type: 'frame_ack', frame_id: 1 });
    assert.equal((await pending).frame_id, 1);
  } finally { link.disconnect(); }
});
test('disconnect rejects an outstanding frame and permits an explicit fresh connection', async () => {
  const link = makeLink();
  await link.connect(); FakeSocket.replyFrame = false;
  const pending = link.sendFrame(new Uint8Array(FRAME_BYTES));
  link.socket.close();
  await assert.rejects(pending, /disconnected/);
  assert.equal(link.ready, false);
  FakeSocket.replyFrame = true;
  try { await link.connect(); assert.equal((await link.sendFrame(new Uint8Array(FRAME_BYTES))).frame_id, 2); }
  finally { link.disconnect(); }
});
test('failed auth and timeouts close the link without exposing the device token', async () => {
  const link = makeLink(); FakeSocket.replyAuth = false;
  const pending = link.connect();
  await Promise.resolve();
  link.socket.message({ type: 'error', code: 'auth_failed' });
  await assert.rejects(pending, error => /auth_failed/.test(error.message) && !error.message.includes(token));
  const stalled = makeLink({ timeoutMs: 100 }); FakeSocket.replyAuth = false;
  await assert.rejects(stalled.connect(), /timed out/);
  assert.equal(stalled.socket, null);
});
test('missing frame ACK times out instead of retaining a queue or showing success', async () => {
  const link = makeLink({ timeoutMs: 100 });
  await link.connect(); FakeSocket.replyFrame = false;
  await assert.rejects(link.sendFrame(new Uint8Array(FRAME_BYTES)), /acknowledgement timed out/);
  assert.equal(link.socket, null);
});
test('invalid JSON, incompatible ready, and throwing user callbacks do not hang promises', async () => {
  const link = makeLink({ onSensors: () => { throw new Error('user callback'); } });
  await link.connect();
  link.socket.message({ type: 'sensors' });
  assert.equal((await link.sendFrame(new Uint8Array(FRAME_BYTES))).frame_id, 1);
  link._message('{');
  assert.equal(link.ready, false);
  const incompatible = makeLink(); FakeSocket.replyAuth = false;
  const pending = incompatible.connect(); await Promise.resolve();
  incompatible.socket.message({ ...info, width: 320 });
  await assert.rejects(pending, /Incompatible/);
});
test('intentional app disconnect reports status without a spurious error', async () => {
  const errors = [], statuses = [];
  const link = makeLink({ onError: error => errors.push(error), onStatus: status => statuses.push(status) });
  await link.connect(); link.disconnect();
  assert.equal(errors.length, 0);
  assert.equal(statuses.at(-1).type, 'disconnected');
});
