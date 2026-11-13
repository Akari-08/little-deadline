/** Hardware-free QA artifact from the same renderer used by the browser canvas. */
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { defaultCompanion } from '../src/pet/state.ts';
import { renderFace, quantizeSurface } from '../src/render/face.ts';
const canvas = createCanvas(240, 320), ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
const companion = defaultCompanion(1000);
companion.pet.xp = 60;
renderFace(ctx, { companion, task: 'Read chapter 3', done: 2, total: 4, status: 'PREVIEW MODE' }, 12000);
quantizeSurface(ctx);
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/face-preview.png', canvas.toBuffer('image/png'));
console.log('Rendered artifacts/face-preview.png · 240×320 · simulated app state');
