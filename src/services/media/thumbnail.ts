import { getAssetBlob } from '@/services/storage/assetRepository';
import { getRecording, saveThumbnail } from '@/services/storage/recordingRepository';

const THUMBNAIL_WIDTH = 480;
const TIMEOUT_MS = 10_000;

/**
 * Renders a JPEG poster frame from a video Blob (needs a DOM; not available in the service worker).
 * Seeks to ~1 s (or a third of short clips) to skip a black first frame. The temporary object URL is
 * always revoked.
 */
export async function generateThumbnail(
  video: Blob,
  durationMs: number,
): Promise<{ blob: Blob; width: number; height: number } | null> {
  const url = URL.createObjectURL(video);
  const element = document.createElement('video');
  element.muted = true;
  element.preload = 'auto';
  element.playsInline = true;

  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        element.addEventListener('loadeddata', () => resolve(), { once: true });
        element.addEventListener('error', () => reject(new Error('This video could not be decoded.')), { once: true });
        element.src = url;
      }),
    );
    const target = Math.min(1, durationMs / 3000);
    if (target > 0) {
      await withTimeout(
        new Promise<void>((resolve) => {
          element.addEventListener('seeked', () => resolve(), { once: true });
          element.currentTime = target;
        }),
      );
    }
    if (!element.videoWidth || !element.videoHeight) return null;

    const width = Math.min(THUMBNAIL_WIDTH, element.videoWidth);
    const height = Math.round((element.videoHeight / element.videoWidth) * width);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(element, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return blob ? { blob, width, height } : null;
  } finally {
    element.removeAttribute('src');
    element.load();
    URL.revokeObjectURL(url);
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out reading the video.')), TIMEOUT_MS)),
  ]);
}

/** Thumbnails are generated one at a time so a large library does not decode many videos at once. */
let queue: Promise<unknown> = Promise.resolve();
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Makes sure a recording has a thumbnail, creating one from its screen video if needed (e.g. for
 * recordings rescued by the service worker). Returns the thumbnail asset id, or null if impossible.
 */
export function ensureThumbnail(recordingId: string): Promise<string | null> {
  const existing = inFlight.get(recordingId);
  if (existing) return existing;
  const task = queue.then(async () => {
    const recording = await getRecording(recordingId);
    if (!recording) return null;
    if (recording.thumbnailAssetId) return recording.thumbnailAssetId;
    const video = await getAssetBlob(recording.screenAssetId);
    if (!video) return null;
    const thumbnail = await generateThumbnail(video, recording.durationMs);
    if (!thumbnail) return null;
    return saveThumbnail(recordingId, thumbnail.blob, thumbnail);
  });
  const settled = task.catch(() => null).finally(() => inFlight.delete(recordingId));
  inFlight.set(recordingId, settled);
  queue = settled;
  return settled;
}
