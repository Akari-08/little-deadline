import { BRAND } from '../branding.ts';
import { mood, remainingTime, type CompanionState } from '../pet/state.ts';
import { DISPLAY_SLIDES, DISPLAY_SLIDE_LABELS } from '../pet/slides.ts';
export const FACE_WIDTH = 240, FACE_HEIGHT = 320;
export interface FaceImage { source: CanvasImageSource; width: number; height: number }
export interface FaceAssets { artwork?: FaceImage | null; spotifyLogo?: FaceImage | null }
export interface FaceState {
  companion: CompanionState; task: string | null; done: number; total: number; status: string;
  tasks?: readonly { title: string; done: boolean }[];
  music?: { connected: boolean; playback: string; track: string | null; artist: string | null; volume: number | null };
  sensors?: { source: string; imu: string; environment: string; temperatureC: number | null; humidityPct: number | null; rssiDbm: number | null };
}
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
export function renderFace(ctx: CanvasRenderingContext2D, state: FaceState, now: number, assets: FaceAssets = {}): void {
  const { companion: s } = state, feeling = mood(s, now);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#19282d'; ctx.fillRect(0, 0, FACE_WIDTH, FACE_HEIGHT);
  for (let y = 0; y < 320; y += 16) for (let x = 0; x < 240; x += 16) {
    if ((x / 16 + y / 16) % 2 === 0) { ctx.fillStyle = '#1c2c30'; ctx.fillRect(x, y, 16, 16); }
  }
  const text = (value: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left') => {
    ctx.fillStyle = color; ctx.font = `${size >= 14 ? '600' : '400'} ${size}px monospace`; ctx.textAlign = align; ctx.fillText(value, x, y);
  };
  const fit = (value: string, width = 184, size = 12) => {
    ctx.font = `600 ${size}px monospace`;
    if (ctx.measureText(value).width <= width) return value;
    let short = value;
    while (short.length > 2 && ctx.measureText(short + '..').width > width) short = short.slice(0, -1);
    return short + '..';
  };
  const slide = s.displaySlide;
  if (slide !== 'pet') {
    text('LIL DEADLINE', 16, 25, 11, '#d2e8d7');
    text(`${DISPLAY_SLIDES.indexOf(slide) + 1} / ${DISPLAY_SLIDES.length}`, 224, 25, 10, '#a6b9a9', 'right');
    if (slide === 'music' && assets.spotifyLogo) {
      const logo = assets.spotifyLogo;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(logo.source, 16, 40, 84, 84 * logo.height / logo.width);
      ctx.imageSmoothingEnabled = false;
    } else text(DISPLAY_SLIDE_LABELS[slide].toUpperCase(), 16, 60, 21, '#c6e7a8');
    ctx.fillStyle = '#31443f'; ctx.fillRect(16, 72, 208, 2);
    if (slide === 'tasks') {
      text(`${state.done} of ${state.total} little wins`, 16, 100, 12, '#c6e7a8');
      const tasks = state.tasks?.filter(task => !task.done).slice(0, 4) ?? [];
      if (!tasks.length) text('All clear for now.', 16, 143, 13, '#ebeee2');
      tasks.forEach((task, index) => {
        const y = 124 + index * 43;
        ctx.fillStyle = '#111f24'; ctx.fillRect(12, y - 17, 216, 37);
        ctx.strokeStyle = '#95b49a'; ctx.strokeRect(22, y - 7, 10, 10);
        text(fit(task.title, 176, 11), 41, y + 2, 11, '#ebeee2');
      });
      text(state.total > 4 ? 'More tasks in the app' : 'One step at a time', 120, 301, 10, '#92aba0', 'center');
    } else if (slide === 'focus') {
      const seconds = Math.ceil(remainingTime(s, now) / 1000);
      const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      text(s.timer.startedAt === null ? 'READY WHEN YOU ARE' : 'ONE THING AT A TIME', 120, 107, 11, '#a1b9ad', 'center');
      text(clock, 120, 173, 44, '#e0d7ed', 'center');
      text(s.timer.startedAt === null ? 'PAUSED' : 'FOCUSING', 120, 195, 11, '#b7dda5', 'center');
      ctx.fillStyle = '#111f24'; ctx.fillRect(12, 222, 216, 62);
      text('CURRENT TASK', 24, 240, 9, '#91ad9d');
      text(fit(state.task ?? 'Choose a little task'), 24, 262, 12, '#ebeee2');
      text(`${s.timer.sessions} sessions completed`, 120, 302, 10, '#92aba0', 'center');
    } else if (slide === 'music') {
      const music = state.music;
      text(music?.connected ? music.playback.toUpperCase() : 'NOT LINKED', 224, 58, 10, '#b7dda5', 'right');
      const art = music?.connected && music.track ? assets.artwork : null;
      ctx.fillStyle = '#111f24'; ctx.fillRect(48, 82, 144, 144);
      if (art && art.width > 0 && art.height > 0) {
        // Contain the entire image, retaining its aspect ratio and unobscured artwork.
        const scale = Math.min(144 / art.width, 144 / art.height);
        const w = art.width * scale, h = art.height * scale, x = (240 - w) / 2, y = 82 + (144 - h) / 2;
        ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.clip();
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(art.source, x, y, w, h); ctx.restore();
      } else text('♪', 120, 179, 66, '#b7dda5', 'center');
      ctx.fillStyle = '#111f24'; ctx.fillRect(12, 234, 216, 51);
      text(fit(music?.track ?? 'Your little soundtrack'), 24, 253, 12, '#ebeee2');
      text(fit(music?.artist ?? (music?.connected ? 'Start playback in Spotify' : 'Link Spotify in Settings'), 186, 10), 24, 273, 10, '#a1b9ad');
      text(music?.volume == null ? 'VOLUME UNAVAILABLE' : `VOLUME ${Math.round(music.volume)}%`, 120, 302, 10, '#92aba0', 'center');
    } else {
      const sensors = state.sensors;
      const source = sensors?.source === 'simulated' ? 'SIMULATED' : sensors?.source === 'device' ? 'DEVICE' : 'UNAVAILABLE';
      text(source, 16, 102, 11, '#b7dda5');
      const rows = [
        ['IMU', sensors?.imu ?? 'unavailable'], ['ROOM TEMP', sensors?.temperatureC == null ? 'unavailable' : `${sensors.temperatureC.toFixed(1)} C`],
        ['HUMIDITY', sensors?.humidityPct == null ? 'unavailable' : `${sensors.humidityPct.toFixed(1)} %`],
        ['WI-FI', sensors?.rssiDbm == null ? 'unavailable' : `${sensors.rssiDbm} dBm`],
      ];
      rows.forEach(([label, value], index) => {
        const y = 139 + index * 38;
        ctx.fillStyle = '#111f24'; ctx.fillRect(12, y - 20, 216, 32);
        text(label!, 21, y, 10, '#91ad9d'); text(fit(value!, 120, 11), 219, y, 11, '#ebeee2', 'right');
      });
      text(`ENV ${sensors?.environment ?? 'unavailable'}`, 120, 302, 10, '#92aba0', 'center');
    }
    ctx.restore(); return;
  }
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
  text(`1 / ${DISPLAY_SLIDES.length}`, 224, 309, 9, '#92aba0', 'right');
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
