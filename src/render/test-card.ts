/**
 * Diagnostic test card for link checks — NOT the pet renderer.
 * Deterministic from `timeMs`: red/green/blue bands (top to bottom) for colour/orientation
 * checks, a white square moving left to right, and a 1-px white border so cropping or
 * mirrored output is visible on the device. Renders opaque RGBA for the canonical surface.
 */
import type { FrameSource, RenderedFrame } from '../device/streamer.ts';

export const SURFACE_WIDTH = 240;
export const SURFACE_HEIGHT = 320;

export function renderTestCard(timeMs: number, out = new Uint8ClampedArray(SURFACE_WIDTH * SURFACE_HEIGHT * 4)): Uint8ClampedArray {
  const squareX = Math.floor(timeMs / 25) % (SURFACE_WIDTH - 20);
  for (let y = 0; y < SURFACE_HEIGHT; y++) {
    for (let x = 0; x < SURFACE_WIDTH; x++) {
      const i = (y * SURFACE_WIDTH + x) * 4;
      const border = x === 0 || y === 0 || x === SURFACE_WIDTH - 1 || y === SURFACE_HEIGHT - 1;
      const square = x >= squareX && x < squareX + 20 && y >= 150 && y < 170;
      const white = border || square;
      out[i] = white || y < 107 ? 255 : 0;
      out[i + 1] = white || (y >= 107 && y < 214) ? 255 : 0;
      out[i + 2] = white || y >= 214 ? 255 : 0;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** A FrameSource that re-renders the test card on demand, with a new seq for each render. */
export class TestCardSource implements FrameSource {
  private seq = 0;
  private frame: RenderedFrame | null = null;
  private readonly clock: () => number;

  constructor(clock: () => number = () => performance.now()) {
    this.clock = clock;
  }

  /** Call from the app's render loop (independent of the streaming rate). */
  render(): void {
    this.frame = { seq: ++this.seq, rgba: renderTestCard(this.clock()) };
  }

  latest(): RenderedFrame | null {
    return this.frame;
  }
}
