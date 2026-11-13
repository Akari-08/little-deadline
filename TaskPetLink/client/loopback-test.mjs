// Real Node WebSocket transport test against an independent local protocol peer.
import http from 'node:http';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { TaskPetLink, FRAME_BYTES } from './taskpet-link.mjs';
const token = 'test-only-device-token-not-a-real-secret';
const pixels = Uint8Array.from({ length: FRAME_BYTES }, (_, i) => i % 251);
const server = http.createServer();
let connection, receivedFrames = 0, nextRow = 0, sensorCount = 0, peerFailure;
function text(socket, message) {
  const payload = Buffer.from(JSON.stringify(message));
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  socket.write(Buffer.concat([header, payload]));
}
server.on('upgrade', (request, socket) => {
  connection = socket;
  const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Protocol: arduino\r\n\r\n');
  text(socket, { type: 'hello', protocol: 'taskpet-link/1', auth_required: true });
  let buffered = Buffer.alloc(0), authenticated = false;
  socket.on('data', chunk => {
    try {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15;
        assert.ok(buffered[0] & 128, 'client must send complete strip messages');
        assert.ok(buffered[1] & 128, 'client messages must be masked');
        let length = buffered[1] & 127, offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        assert.notEqual(length, 127, 'strip must fit a short WebSocket message');
        if (buffered.length < offset + 4 + length) return;
        const mask = buffered.subarray(offset, offset + 4);
        const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < payload.length; ++i) payload[i] ^= mask[i % 4];
        buffered = buffered.subarray(offset + 4 + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode === 1) {
          assert.equal(payload.toString(), 'AUTH ' + token);
          authenticated = true;
          text(socket, { type: 'ready', protocol: 'taskpet-link/1', width: 240, height: 320, format: 'rgb565le', max_strip_rows: 16 });
        } else if (opcode === 2) {
          assert.ok(authenticated);
          assert.equal(payload.subarray(0, 4).toString(), 'TPX1');
          assert.equal(payload.readUInt16LE(8), nextRow);
          const rows = payload.readUInt16LE(10);
          assert.equal(rows, 16);
          assert.equal(payload.length, 7692);
          assert.deepEqual(payload.subarray(12), Buffer.from(pixels.subarray(nextRow * 480, (nextRow + rows) * 480)));
          nextRow += rows;
          if (nextRow === 320) {
            nextRow = 0; ++receivedFrames;
            text(socket, { type: 'sensors', seq: receivedFrames, imu: { valid: false, accel_m_s2: [null, null, null] } });
            text(socket, { type: 'frame_ack', frame_id: payload.readUInt32LE(4) });
          }
        } else throw new Error('Unexpected opcode ' + opcode);
      }
    } catch (error) { peerFailure = error; socket.destroy(); }
  });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const link = new TaskPetLink({ url: `ws://127.0.0.1:${server.address().port}/`, token, onSensors: () => ++sensorCount });
try {
  await link.connect();
  assert.equal((await link.sendFrame(pixels)).frame_id, 1);
  assert.equal((await link.sendFrame(pixels)).frame_id, 2);
  assert.equal(receivedFrames, 2);
  assert.equal(sensorCount, 2);
  if (peerFailure) throw peerFailure;
  console.log('PASS: native Node WebSocket auth, 40 binary strips, 2 full frames, ACKs and simultaneous telemetry over real loopback TCP');
} finally {
  link.disconnect(); connection?.destroy();
  await new Promise(resolve => server.close(resolve));
}

