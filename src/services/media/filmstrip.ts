/** Small preview frames of a video, evenly spaced in source time (for timeline clips). */
export interface Filmstrip {
  /** Source time between frames; frame `i` shows `i * intervalMs`. */
  intervalMs: number;
  /** JPEG object URLs, in order. */
  frames: string[];
  /** Width / height of the frames. */
  aspect: number;
}

const FRAME_HEIGHT = 72;
const MAX_FRAMES = 90;
const MIN_INTERVAL_MS = 500;

/** Spacing that keeps the number of decoded frames bounded for long videos. */
export function filmstripInterval(durationMs: number): number {
  return Math.max(MIN_INTERVAL_MS, Math.ceil(durationMs / MAX_FRAMES));
}

/**
 * Decodes evenly spaced frames of a video with Mediabunny (works for recordings without a seek
 * index, unlike a <video> element). Returns null when the file can't be decoded.
 */
export async function createFilmstrip(video: Blob, durationMs: number, signal?: AbortSignal): Promise<Filmstrip | null> {
  const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import('mediabunny');
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(video) });
  const frames: string[] = [];
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;
    const width = await track.getDisplayWidth();
    const height = await track.getDisplayHeight();
    const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
    const intervalMs = filmstripInterval(durationMs);
    const times: number[] = [];
    for (let ms = 0; ms < durationMs; ms += intervalMs) times.push(ms / 1000);
    const sink = new CanvasSink(track, { height: FRAME_HEIGHT, width: Math.round(FRAME_HEIGHT * aspect), fit: 'cover' });
    // One entry per timestamp, so frame i stays at i * intervalMs. A timestamp without a frame
    // (e.g. before the first one) borrows the nearest decoded frame.
    const slots: Array<string | null> = [];
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (signal?.aborted) break;
      const url = wrapped ? await toUrl(wrapped.canvas) : null;
      slots.push(url);
      if (url) frames.push(url);
    }
    if (signal?.aborted || frames.length === 0) {
      revoke(frames);
      return null;
    }
    const filled = slots.map((url, index) => url ?? slots.slice(index).find(Boolean) ?? slots.slice(0, index).findLast(Boolean)!);
    return { intervalMs, frames: filled, aspect };
  } catch {
    revoke(frames);
    return null;
  } finally {
    input.dispose();
  }
}

async function toUrl(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string | null> {
  const blob =
    'convertToBlob' in canvas
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
      : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.7));
  return blob ? URL.createObjectURL(blob) : null;
}

export function revoke(frames: readonly string[]): void {
  for (const url of new Set(frames)) URL.revokeObjectURL(url);
}

/** The frame closest to a source time. */
export function frameAt(strip: Filmstrip, sourceMs: number): string | undefined {
  const index = Math.min(strip.frames.length - 1, Math.max(0, Math.round(sourceMs / strip.intervalMs)));
  return strip.frames[index];
}
