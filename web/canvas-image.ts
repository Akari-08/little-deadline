import type { FaceImage } from '../src/render/face.ts';

/** Decode outside the renderer. Only local images may touch the readable display canvas. */
export class CanvasImageLoader {
  private url: string | null = null;
  private image: HTMLImageElement | null = null;
  private ready: FaceImage | null = null;
  private retryAt = 0;
  private readonly makeImage: () => HTMLImageElement;
  private readonly clock: () => number;
  constructor(makeImage: () => HTMLImageElement = () => new Image(), clock = () => performance.now()) { this.makeImage = makeImage; this.clock = clock; }
  update(url: string | null, now: number): FaceImage | null {
    if (url !== '/spotify-logo.svg' && !/^\/api\/spotify\/artwork\?id=[a-f\d]{64}$/.test(url ?? '')) url = null;
    if (url !== this.url) { this.dispose(); this.url = url; }
    if (url && !this.image && now >= this.retryAt) {
      const image = this.makeImage(); this.image = image;
      image.onload = () => {
        if (this.image !== image) return;
        if (image.naturalWidth > 0 && image.naturalHeight > 0 && image.naturalWidth <= 4096 && image.naturalHeight <= 4096) {
          this.ready = { source: image, width: image.naturalWidth, height: image.naturalHeight };
        } else fail();
      };
      const fail = () => {
        if (this.image !== image) return;
        image.onload = null; image.onerror = null;
        this.image = null; this.ready = null; this.retryAt = this.clock() + 30_000;
      };
      image.onerror = fail;
      image.src = url;
    }
    return this.ready;
  }
  dispose(): void {
    if (this.image) { this.image.onload = null; this.image.onerror = null; this.image.src = ''; }
    this.image = null; this.ready = null; this.url = null; this.retryAt = 0;
  }
}
