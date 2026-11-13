import { BRAND } from '../branding.ts';
import { mood, remainingTime, type CompanionState } from '../pet/state.ts';
export const FACE_WIDTH = 240, FACE_HEIGHT = 320;
export interface FaceState { companion: CompanionState; task: string | null; done: number; total: number; status: string }
const sprite = [
  '        gg       ',
  '       gGGg      ',
  '   gg  gGGg      ',
  '  gGGggGGg       ',
  '   gGGGGg        ',
  '     gg          ',
  '    ooooooo      ',
  '  ooLLLLLLLoo    ',
  ' oLLLLLLLLLLLo   ',
  'oLLLLLLLLLLLLLo  ',
  'oLLLLLLLLLLLLLo  ',
  'oLLLLLLLLLLLLLo  ',
  'oLLLLLLLLLLLLLo  ',
  ' oLLLLLLLLLLLo   ',
  '  ooLLLLLLLoo    ',
  '    ooooooo      ',
  '    oo   oo      ',
];
export function renderFace(ctx: CanvasRenderingContext2D, state: FaceState, now: number): void {
  const { companion: s } = state, feeling = mood(s, now);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#19282d'; ctx.fillRect(0, 0, FACE_WIDTH, FACE_HEIGHT);
  for (let y = 0; y < 320; y += 16) for (let x = 0; x < 240; x += 16) {
    if ((x / 16 + y / 16) % 2 === 0) { ctx.fillStyle = '#1c2c30'; ctx.fillRect(x, y, 16, 16); }
  }
  const text = (value: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left') => {
    ctx.fillStyle = color; ctx.font = `${size >= 14 ? '600' : '400'} ${size}px monospace`; ctx.textAlign = align; ctx.fillText(value, x, y);
  };
  text(BRAND.petName.toUpperCase(), 16, 25, 12, '#d2e8d7');
  text(`LV ${1 + Math.floor(s.pet.xp / 100)}`, 224, 25, 10, '#a6b9a9', 'right');
  text(feeling === 'celebrating' ? 'Look at you grow!' : feeling === 'sleepy' ? 'A little rest...' : feeling === 'focused' ? 'One thing at a time.' : 'Little steps count.', 120, 49, 11, '#a1b9ad', 'center');
  ctx.lineWidth = 3; ctx.strokeStyle = '#31443f'; ctx.beginPath(); ctx.arc(120, 140, 72, 0, Math.PI * 2); ctx.stroke();
  if (state.total) { ctx.strokeStyle = '#b7dda5'; ctx.beginPath(); ctx.arc(120, 140, 72, -Math.PI / 2, -Math.PI / 2 + state.done / state.total * Math.PI * 2); ctx.stroke(); }
  const bob = feeling === 'sleepy' ? 1 : Math.round(Math.sin(now / (feeling === 'celebrating' ? 100 : 450)) * (feeling === 'celebrating' ? 5 : 2));
  const lean = now - s.pet.lastInteractionAt < 2500 ? s.pet.lean * 8 : 0;
  ctx.fillStyle = '#122024'; ctx.beginPath(); ctx.ellipse(120, 192, 45, 8, 0, 0, Math.PI * 2); ctx.fill();
  const x0 = 78 + lean, y0 = 92 + bob, scale = 6;
  const palette: Record<string, string> = { g: '#52896d', G: '#9dcd87', o: '#86ad7d', L: '#c6e7a8' };
  sprite.forEach((row, y) => [...row].forEach((pixel, x) => { if (palette[pixel]) { ctx.fillStyle = palette[pixel]!; ctx.fillRect(x0 + x * scale, y0 + y * scale, scale, scale); } }));
  const blink = feeling === 'sleepy' || now % 4200 < 170;
  ctx.fillStyle = '#29443b';
  ctx.fillRect(x0 + 24, y0 + 58, 6, blink ? 2 : 9); ctx.fillRect(x0 + 54, y0 + 58, 6, blink ? 2 : 9);
  ctx.fillRect(x0 + 36, y0 + 73, 12, 3); ctx.fillRect(x0 + 33, y0 + 70, 3, 3); ctx.fillRect(x0 + 48, y0 + 70, 3, 3);
  ctx.fillStyle = '#e3b9a0'; ctx.fillRect(x0 + 15, y0 + 69, 9, 4); ctx.fillRect(x0 + 60, y0 + 69, 9, 4);
  if (feeling === 'sleepy') text('z', 180, 110, 15, '#b7addd');
  if (feeling === 'celebrating' || feeling === 'happy') {
    for (let n = 0; n < 5; n++) {
      const x = 39 + n * 39, y = 74 + ((n * 29 + Math.floor(now / 100)) % 115);
      text(n % 2 ? '+' : '*', x, y, 12, n % 2 ? '#bcb1e7' : '#e0c58b');
    }
  }
  text(`${state.done} / ${state.total} little wins`, 120, 228, 11, '#d4e5c8', 'center');
  ctx.fillStyle = '#111f24'; ctx.fillRect(12, 237, 216, 57);
  text(s.timer.startedAt !== null ? 'FOCUSING ON' : 'UP NEXT', 24, 253, 9, '#91ad9d');
  const title = state.task ?? 'Room for a new beginning';
  let truncated = title; ctx.font = '600 12px monospace';
  while (ctx.measureText(truncated).width > 186) truncated = truncated.slice(0, -1);
  if (truncated.length < title.length) truncated = truncated.slice(0, -2) + '..';
  text(truncated, 24, 277, 12, '#ebeee2');
  const seconds = Math.ceil(remainingTime(s, now) / 1000);
  text(s.timer.startedAt !== null ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} focus` : state.status, 120, 309, 9, '#92aba0', 'center');
  ctx.restore();
}
/** Optional RGB565-quantized preview; modifies the canonical surface before upload. */
export function quantizeSurface(ctx: CanvasRenderingContext2D): void {
  const image = ctx.getImageData(0, 0, FACE_WIDTH, FACE_HEIGHT), data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]! >> 3, g = data[i + 1]! >> 2, b = data[i + 2]! >> 3;
    data[i] = (r << 3) | (r >> 2); data[i + 1] = (g << 2) | (g >> 4); data[i + 2] = (b << 3) | (b >> 2); data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}
