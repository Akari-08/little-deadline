/** Hardware-free QA artifact from the same renderer used by the browser canvas. */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { defaultCompanion } from '../src/pet/state.ts';
import { renderFace, quantizeSurface } from '../src/render/face.ts';
import { DISPLAY_SLIDES } from '../src/pet/slides.ts';
const canvas = createCanvas(240, 320), ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
const sheet = createCanvas(240 * DISPLAY_SLIDES.length, 320), sheetCtx = sheet.getContext('2d');
const companion = defaultCompanion(1000);
companion.pet.xp = 60;
// Original synthetic cover for hardware-free QA; never presented as Spotify data.
const cover = createCanvas(300, 300), art = cover.getContext('2d');
art.fillStyle = '#263b64'; art.fillRect(0, 0, 300, 300);
art.fillStyle = '#eab47b'; art.beginPath(); art.arc(185, 100, 57, 0, Math.PI * 2); art.fill();
art.fillStyle = '#426e74'; art.beginPath(); art.moveTo(0, 210); art.lineTo(90, 130); art.lineTo(210, 245); art.lineTo(300, 175); art.lineTo(300, 300); art.lineTo(0, 300); art.fill();
art.fillStyle = '#f0e7d4'; art.font = '20px sans-serif'; art.fillText('PREVIEW SAMPLE', 20, 276);
const logo = await loadImage('public/spotify-logo.svg');
const assets = { artwork: { source: cover as unknown as CanvasImageSource, width: 300, height: 300 },
  spotifyLogo: { source: logo as unknown as CanvasImageSource, width: logo.width, height: logo.height } };
mkdirSync('artifacts', { recursive: true });
for (const [index, slide] of DISPLAY_SLIDES.entries()) {
  companion.displaySlide = slide;
  renderFace(ctx, { companion, task: 'Read chapter 3', done: 2, total: 4, status: 'PREVIEW MODE',
    tasks: [{ title: 'Read chapter 3', done: false }, { title: 'Write a short reflection', done: false }],
    music: { connected: true, playback: 'playing', track: 'Midnight Garden', artist: 'Preview sample', volume: 40 },
    sensors: { source: 'unavailable', imu: 'unavailable', environment: 'unavailable', temperatureC: null, humidityPct: null, rssiDbm: null } }, 12000, assets);
  quantizeSurface(ctx);
  writeFileSync(`artifacts/slide-${slide}.png`, canvas.toBuffer('image/png'));
  if (slide === 'pet') writeFileSync('artifacts/face-preview.png', canvas.toBuffer('image/png'));
  sheetCtx.drawImage(canvas, index * 240, 0);
}
writeFileSync('artifacts/slide-contact-sheet.png', sheet.toBuffer('image/png'));
console.log('Rendered five 240×320 slides and artifacts/slide-contact-sheet.png · simulated app state');
