import { closePdf, renderPdfPage } from '@/services/media/pdf';

/**
 * Decoded stills (images and PDF pages) for the preview and the export, drawn at the size they are
 * shown rather than at full resolution, and only a few kept at once, so large images and long PDFs
 * don't fill memory. The least recently used bitmap is released first.
 */

export interface StillSource {
  assetId: string;
  kind: 'image' | 'pdf';
  /** PDF page (1-based). */
  page?: number;
  /** Images: their size, so they can be decoded straight to the size needed. */
  size?: { width: number; height: number };
  /** The file's bytes (loaded only when the still is first needed). */
  load: () => Promise<Blob>;
}

/** Size buckets, so a slightly resized preview reuses the bitmap it has. */
const BUCKET = 256;
const bucket = (value: number) => Math.max(BUCKET, Math.ceil(value / BUCKET) * BUCKET);

export class StillCache {
  private readonly bitmaps = new Map<string, ImageBitmap>();
  private readonly pending = new Map<string, Promise<ImageBitmap | null>>();
  private readonly failed = new Set<string>();
  private closed = false;

  /** `limit`: bitmaps kept; `onReady`: called when a requested still has been decoded. */
  constructor(
    private readonly limit = 12,
    private readonly onReady?: () => void,
  ) {}

  private key(source: StillSource, box: { width: number; height: number }) {
    return `${source.assetId}#${source.page ?? 0}@${bucket(box.width)}x${bucket(box.height)}`;
  }

  /** The bitmap if already decoded (no waiting); otherwise starts decoding and returns null. */
  peek(source: StillSource, box: { width: number; height: number }): ImageBitmap | null {
    const key = this.key(source, box);
    const ready = this.bitmaps.get(key);
    if (ready) {
      this.touch(key, ready);
      return ready;
    }
    if (!this.failed.has(key)) void this.decode(key, source, box);
    return null;
  }

  /** The bitmap, decoding it if needed; null if it can't be read. */
  async get(source: StillSource, box: { width: number; height: number }): Promise<ImageBitmap | null> {
    const key = this.key(source, box);
    const ready = this.bitmaps.get(key);
    if (ready) {
      this.touch(key, ready);
      return ready;
    }
    if (this.failed.has(key)) return null;
    return this.decode(key, source, box);
  }

  /** Whether this still failed to decode (e.g. a damaged image). */
  hasFailed(source: StillSource, box: { width: number; height: number }): boolean {
    return this.failed.has(this.key(source, box));
  }

  /** Releases every bitmap and open PDF. */
  clear(): void {
    this.closed = true;
    for (const bitmap of this.bitmaps.values()) bitmap.close();
    this.bitmaps.clear();
    this.pending.clear();
    for (const assetId of this.pdfs) closePdf(assetId);
    this.pdfs.clear();
  }

  private readonly pdfs = new Set<string>();

  private touch(key: string, bitmap: ImageBitmap) {
    this.bitmaps.delete(key);
    this.bitmaps.set(key, bitmap);
  }

  private decode(key: string, source: StillSource, box: { width: number; height: number }): Promise<ImageBitmap | null> {
    let promise = this.pending.get(key);
    if (promise) return promise;
    const target = { width: bucket(box.width), height: bucket(box.height) };
    promise = (async () => {
      try {
        let bitmap: ImageBitmap;
        if (source.kind === 'pdf') {
          this.pdfs.add(source.assetId);
          bitmap = await renderPdfPage(source.assetId, source.load, source.page ?? 1, target);
        } else {
          bitmap = await decodeImage(await source.load(), target, source.size);
        }
        if (this.closed) {
          bitmap.close();
          return null;
        }
        this.bitmaps.set(key, bitmap);
        while (this.bitmaps.size > this.limit) {
          const [oldest, old] = this.bitmaps.entries().next().value!;
          this.bitmaps.delete(oldest);
          old.close();
        }
        this.onReady?.();
        return bitmap;
      } catch {
        this.failed.add(key);
        return null;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, promise);
    return promise;
  }
}

/**
 * Decodes an image no larger than needed to fill `box` (keeping its shape; never enlarged). With
 * its size known, the browser decodes it straight to that size, without a full-size copy.
 */
export async function decodeImage(blob: Blob, box: { width: number; height: number }, size?: { width: number; height: number }): Promise<ImageBitmap> {
  const resized = (width: number, height: number) => {
    const scale = Math.min(1, box.width / width, box.height / height);
    return { resizeWidth: Math.max(1, Math.round(width * scale)), resizeHeight: Math.max(1, Math.round(height * scale)), resizeQuality: 'high' as const };
  };
  if (size && size.width > 0 && size.height > 0) return createImageBitmap(blob, resized(size.width, size.height));
  const full = await createImageBitmap(blob);
  if (Math.min(1, box.width / full.width, box.height / full.height) >= 1) return full;
  try {
    return await createImageBitmap(full, resized(full.width, full.height));
  } finally {
    full.close();
  }
}
