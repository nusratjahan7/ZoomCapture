/**
 * Small preview pictures for the media library and timeline clips: a frame of a video, an image,
 * or a PDF page, drawn at most 160 px wide. Made once per file (and page) while the editor is
 * open; the object URLs are released when the file leaves the project.
 */
import { getAssetBlob } from '@/services/storage/assetRepository';
import type { MediaAsset } from '@/types';
import { renderPdfPage } from './pdf';
import { decodeImage } from '@/services/render/stills';

const BOX = { width: 160, height: 160 };
const thumbnails = new Map<string, Promise<string | null>>();

async function toUrl(source: CanvasImageSource, width: number, height: number): Promise<string | null> {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')?.drawImage(source, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  return URL.createObjectURL(blob);
}

async function bitmapUrl(bitmap: ImageBitmap): Promise<string | null> {
  try {
    return await toUrl(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

async function videoFrameUrl(blob: Blob, durationMs: number): Promise<string | null> {
  const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import('mediabunny');
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;
    const sink = new CanvasSink(track, { width: BOX.width });
    // A little way in, past a black first frame.
    const wrapped = await sink.getCanvas(Math.min(1, durationMs / 3000));
    return wrapped ? toUrl(wrapped.canvas, wrapped.canvas.width, wrapped.canvas.height) : null;
  } finally {
    input.dispose();
  }
}

async function make(asset: MediaAsset, page: number): Promise<string | null> {
  const load = async () => {
    const blob = await getAssetBlob(asset.id);
    if (!blob) throw new Error('missing');
    return blob;
  };
  switch (asset.kind) {
    case 'pdf':
      return bitmapUrl(await renderPdfPage(asset.id, load, page, BOX));
    case 'image':
      return bitmapUrl(await decodeImage(await load(), BOX, asset.width && asset.height ? { width: asset.width, height: asset.height } : undefined));
    case 'video':
    case 'screen':
    case 'camera':
      return videoFrameUrl(await load(), asset.durationMs ?? 0);
    default:
      return null;
  }
}

/** A thumbnail URL for a file (and PDF page), or null for audio and unreadable files. */
export function thumbnailFor(asset: MediaAsset, page = 1): Promise<string | null> {
  const key = `${asset.id}#${page}`;
  let thumbnail = thumbnails.get(key);
  if (!thumbnail) {
    thumbnail = make(asset, page).catch(() => null);
    thumbnails.set(key, thumbnail);
  }
  return thumbnail;
}

/** Releases a file's thumbnails. */
export function forgetThumbnails(assetId: string): void {
  for (const [key, url] of thumbnails) {
    if (!key.startsWith(`${assetId}#`)) continue;
    thumbnails.delete(key);
    void url.then((value) => value && URL.revokeObjectURL(value));
  }
}
