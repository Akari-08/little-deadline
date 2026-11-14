import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CvMusicBridge, parseGestureLine } from '../src/cv/music-bridge.ts';
import type { CameraConsumer } from '../src/camera/proxy.ts';
import type { SpotifyService } from '../src/spotify/service.ts';

function harness() {
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { killed++; return true; } });
  const packets: Buffer[] = []; process.stdin.on('data', chunk => packets.push(Buffer.from(chunk)));
  let consumer: CameraConsumer | null = null, released = 0, killed = 0, greeted = 0;
  const slides: string[] = [];
  const bridge = new CvMusicBridge({ status: () => ({ connected: false }) } as unknown as SpotifyService,
    () => { greeted++; }, direction => slides.push(direction),
    { subscribe: (_address, _token, value) => { consumer = value; return () => { released++; }; } },
    () => process as unknown as ChildProcessWithoutNullStreams);
  return { bridge, packets, emit: (event: unknown) => process.stdout.write(JSON.stringify(event) + '\n'),
    frame: (n: number) => consumer!.onFrame({ jpeg: Buffer.from([255,216,n,255,217]), receivedAt: n * 200 }),
    error: () => consumer!.onError('Camera disconnected.', 503),
    counts: () => ({ released, killed, greeted, slides }) };
}

test('ESP gestures wait for the model and process only one frame plus the latest replacement', () => {
  const h = harness();
  try {
    h.bridge.start('ws://192.168.1.123:81/', 'synthetic-device-token');
    h.frame(1); h.frame(2); assert.equal(h.packets.length, 0);
    h.emit({ kind: 'ready' }); assert.equal(h.packets.length, 1);
    assert.equal(h.bridge.status().phase, 'starting');
    assert.equal(h.packets[0]!.readUInt32LE(), 5);
    assert.equal(h.packets[0]!.readBigUInt64LE(4), 400n);
    h.frame(3); h.frame(4); h.frame(5);
    assert.equal(h.packets.length, 1);
    h.emit({ kind: 'frame_processed', timestamp: 400, width: 800, height: 600 });
    assert.equal(h.packets.length, 2); assert.equal(h.packets[1]![14], 5);
    assert.equal(h.packets[1]!.readBigUInt64LE(4), 1000n);
    assert.equal(h.bridge.status().phase, 'live'); assert.equal(h.bridge.status().width, 800);
    h.emit({ kind: 'gesture', action: 'greet' });
    h.emit({ kind: 'gesture', action: 'slide_next' });
    assert.equal(h.counts().greeted, 1); assert.deepEqual(h.counts().slides, ['next']);
    h.emit({ kind: 'gesture', action: 'music_toggle' });
    h.emit({ kind: 'frame_processed', timestamp: 1000, width: 800, height: 600 });
    assert.match(h.bridge.status().message, /Connect Spotify/);
    h.bridge.stop(); h.emit({ kind: 'gesture', action: 'greet' }); h.frame(6);
    assert.equal(h.counts().greeted, 1); assert.equal(h.packets.length, 2);
    assert.equal(h.counts().released, 1); assert.equal(h.counts().killed, 1);
  } finally { h.bridge.stop(); }
});

test('source failure and unmatched acknowledgements stop gesture processing', () => {
  for (const cause of ['camera', 'ack']) {
    const h = harness();
    try {
      h.bridge.start('ws://192.168.1.123:81/', 'synthetic-device-token');
      h.emit({ kind: 'ready' }); h.frame(1);
      if (cause === 'camera') h.error();
      else h.emit({ kind: 'frame_processed', timestamp: 999, width: 800, height: 600 });
      assert.equal(h.bridge.status().phase, 'error');
      assert.equal(h.counts().released, 1); assert.equal(h.counts().killed, 1);
    } finally { h.bridge.stop(); }
  }
});

test('frame acknowledgements require bounded integer timestamps and dimensions', () => {
  for (const fields of [{ timestamp: -1, width: 800, height: 600 }, { timestamp: 10, width: 9000, height: 600 }, { timestamp: 10, width: 800, height: 0 }]) {
    assert.equal(parseGestureLine(JSON.stringify({ kind: 'frame_processed', ...fields })), null);
  }
});
