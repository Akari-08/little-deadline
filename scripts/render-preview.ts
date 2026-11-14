/** Hardware-free QA artifact from the same renderer used by the browser canvas. */
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { defaultCompanion } from '../src/pet/state.ts';
import { renderFace, quantizeSurface } from '../src/render/face.ts';
import { DISPLAY_SLIDES } from '../src/pet/slides.ts';
const canvas = createCanvas(240, 320), ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
const sheet = createCanvas(240 * DISPLAY_SLIDES.length, 320), sheetCtx = sheet.getContext('2d');
const companion = defaultCompanion(1000);
companion.pet.xp = 60;
mkdirSync('artifacts', { recursive: true });
for (const [index, slide] of DISPLAY_SLIDES.entries()) {
  companion.displaySlide = slide;
  renderFace(ctx, { companion, task: 'Read chapter 3', done: 2, total: 4, status: 'PREVIEW MODE',
    tasks: [{ title: 'Read chapter 3', done: false }, { title: 'Write a short reflection', done: false }],
    music: { connected: false, playback: 'unknown', track: null, artist: null, volume: null },
    sensors: { source: 'unavailable', imu: 'unavailable', environment: 'unavailable', temperatureC: null, humidityPct: null, rssiDbm: null } }, 12000);
  quantizeSurface(ctx);
  writeFileSync(`artifacts/slide-${slide}.png`, canvas.toBuffer('image/png'));
  if (slide === 'pet') writeFileSync('artifacts/face-preview.png', canvas.toBuffer('image/png'));
  sheetCtx.drawImage(canvas, index * 240, 0);
}
writeFileSync('artifacts/slide-contact-sheet.png', sheet.toBuffer('image/png'));
console.log('Rendered five 240×320 slides and artifacts/slide-contact-sheet.png · simulated app state');
