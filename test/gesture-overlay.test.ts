import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { drawHandOverlay, parsePreviewMetadata } from '../web/gesture-overlay.ts';
import { parseHandTracking, type HandTracking } from '../src/cv/tracking.ts';

test('finger joints stay aligned with normalized image positions at different native resolutions', () => {
  const tracking: HandTracking = { pose: 'point_right', landmarks: Array.from({ length: 21 }, () => [0.4, 0.6]) };
  tracking.landmarks[8] = [0.8, 0.5];
  for (const [width, height] of [[800,600],[320,240]]) {
    const canvas = createCanvas(width!, height!), context = canvas.getContext('2d');
    context.fillStyle = '#101010'; context.fillRect(0, 0, width!, height!);
    drawHandOverlay(context as unknown as CanvasRenderingContext2D, width!, height!, tracking);
    const tip = context.getImageData(width! * 0.8, height! * 0.5, 1, 1).data;
    assert.deepEqual([...tip], [255,218,145,255]);
    const untouched = context.getImageData(0, 0, 1, 1).data;
    assert.deepEqual([...untouched], [16,16,16,255]);
  }
});

test('no-hand frame adds no points and preview metadata is bounded', () => {
  const canvas = createCanvas(320,240), context = canvas.getContext('2d');
  const before = Buffer.from(context.getImageData(0,0,320,240).data);
  drawHandOverlay(context as unknown as CanvasRenderingContext2D, 320,240, { pose: null, landmarks: [] });
  assert.deepEqual(Buffer.from(context.getImageData(0,0,320,240).data), before);
  assert.ok(parsePreviewMetadata(JSON.stringify({ timestamp: 1, width: 800, height: 600, tracking: { pose: null, landmarks: [] } })));
  assert.equal(parsePreviewMetadata('null'), null);
  assert.equal(parsePreviewMetadata('x'.repeat(4097)), null);
  assert.equal(parsePreviewMetadata(JSON.stringify({ timestamp: 1, width: -1, height: 600, tracking: { pose: null, landmarks: [] } })), null);
  assert.equal(parseHandTracking({ pose: 'fist', landmarks: Array(21).fill([NaN, 0.5]) }), null);
});
