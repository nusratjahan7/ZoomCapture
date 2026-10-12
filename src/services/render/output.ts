import type { Size } from '@/services/zoom/coordinates';
import type { ExportSettings } from '@/types';

/** Output heights for each resolution setting; `source` keeps the recording's size. */
export const RESOLUTION_HEIGHT: Record<Exclude<ExportSettings['resolution'], 'source'>, number> = {
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440,
  '2160p': 2160,
};

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/**
 * Output frame size: the recording's aspect ratio at the requested height, never upscaled, with
 * even dimensions (required by most video encoders).
 */
export function outputSize(source: Size, resolution: ExportSettings['resolution']): Size {
  const height = resolution === 'source' ? source.height : Math.min(RESOLUTION_HEIGHT[resolution], source.height);
  return { width: even((source.width * height) / source.height), height: even(height) };
}

/** Smaller sizes to try, in order, when the encoder rejects `size` (e.g. 4K on some devices). */
export function fallbackSizes(source: Size, size: Size): Size[] {
  return [1440, 1080, 720, 480]
    .filter((height) => height < size.height)
    .map((height) => ({ width: even((source.width * height) / source.height), height }));
}

/**
 * Timestamps (seconds) of every output frame: a constant frame rate over the whole duration.
 * Recordings are variable-frame-rate (a still screen produces few frames), so rendering at the
 * source frames would make zoom animations stutter; each output frame instead shows the latest
 * source frame at its time with the effects evaluated at exactly that time.
 */
export function frameTimestamps(durationSeconds: number, frameRate: number): number[] {
  const count = Math.max(1, Math.ceil(durationSeconds * frameRate - 1e-6));
  return Array.from({ length: count }, (_, index) => index / frameRate);
}
