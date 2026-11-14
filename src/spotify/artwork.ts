import { createHash } from 'node:crypto';

const MAX_BYTES = 1024 * 1024;
export interface ArtworkBytes { bytes: Buffer; contentType: string }
type Cover = { source: string; id: string; controller: AbortController; cached: ArtworkBytes | null; flight: Promise<ArtworkBytes | null> | null; retryAt: number };

/** Prefer the smallest cover at least as large as the 144px display image. */
function selectCover(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  const candidates = images.flatMap((image: unknown) => {
    if (!image || typeof image !== 'object') return [];
    const { url, width } = image as Record<string, unknown>;
    // Only Spotify's image CDN; never proxy arbitrary URLs, redirects or credentials.
    if (typeof url !== 'string' || !/^https:\/\/i\.scdn\.co\/image\/[a-f\d]{40}$/i.test(url)) return [];
    return [{ url, width: typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 0 }];
  });
  const suitable = candidates.filter(image => image.width >= 144).sort((a, b) => a.width - b.width);
  return suitable[0]?.url ?? candidates.sort((a, b) => b.width - a.width)[0]?.url ?? null;
}

/** One in-memory cover, shared by local clients. No OAuth credentials go to the CDN. */
export class SpotifyArtwork {
  private current: Cover | null = null;
  private readonly fetchFn: typeof fetch;
  constructor(fetchFn: typeof fetch = fetch) { this.fetchFn = fetchFn; }
  select(images: unknown): string | null {
    const source = selectCover(images);
    if (source !== this.current?.source) {
      this.clear();
      if (source) this.current = { source, id: createHash('sha256').update(source).digest('hex'), controller: new AbortController(), cached: null, flight: null, retryAt: 0 };
    }
    return this.current ? `/api/spotify/artwork?id=${this.current.id}` : null;
  }
  clear(): void { this.current?.controller.abort(); this.current = null; }
  async get(id: string | null): Promise<ArtworkBytes | null> {
    const cover = this.current;
    if (!cover || id !== cover.id) return null;
    if (cover.cached) return cover.cached;
    if (Date.now() < cover.retryAt) return null;
    cover.flight ??= this.download(cover).then(image => {
      if (this.current !== cover) return null;
      cover.cached = image;
      return image;
    }).catch(() => { cover.retryAt = Date.now() + 30_000; return null; }).finally(() => { cover.flight = null; });
    return cover.flight;
  }
  private async download(cover: Cover): Promise<ArtworkBytes> {
    const response = await this.fetchFn(cover.source, { redirect: 'error', credentials: 'omit',
      signal: AbortSignal.any([cover.controller.signal, AbortSignal.timeout(5000)]) });
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!response.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(contentType) ||
        Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) {
      await response.body?.cancel(); throw new Error('Artwork unavailable.');
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error('Artwork too large.');
        chunks.push(value);
      }
      if (!size) throw new Error('Artwork empty.');
      return { bytes: Buffer.concat(chunks, size), contentType };
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
}
