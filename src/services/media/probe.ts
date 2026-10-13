/** Facts about an imported file, read before it is stored. */
export interface ProbedMedia {
  durationMs?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
}

export class UnsupportedMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedMediaError';
  }
}

/**
 * Reads the length, picture size and audio presence of a video, audio or image file, and checks
 * that this browser can decode it, so unsupported files are refused at import with a clear
 * reason instead of failing later in the preview or the rendered video.
 */
export async function probeMedia(file: Blob): Promise<ProbedMedia> {
  if (file.type.startsWith('image/')) {
    try {
      const bitmap = await createImageBitmap(file);
      const result = { width: bitmap.width, height: bitmap.height, hasAudio: false };
      bitmap.close();
      return result;
    } catch {
      throw new UnsupportedMediaError('This image can’t be read by the browser.');
    }
  }
  if (!file.type.startsWith('video/') && !file.type.startsWith('audio/')) {
    throw new UnsupportedMediaError('Only video, audio and image files can be imported.');
  }

  // Loaded on demand: the media library is only needed for imports and rendering.
  const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny');
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    if (!(await input.canRead())) throw new UnsupportedMediaError('This file format isn’t supported. Try MP4, WebM, MP3, WAV or OGG.');
    const video = file.type.startsWith('video/') ? await input.getPrimaryVideoTrack() : null;
    const audio = await input.getPrimaryAudioTrack();
    if (file.type.startsWith('video/') && !video) throw new UnsupportedMediaError('This video file has no picture.');
    if (video && !(await video.canDecode())) {
      throw new UnsupportedMediaError(`This browser can’t play this video’s format (${video.codec ?? 'unknown codec'}).`);
    }
    if (!video && !audio) throw new UnsupportedMediaError('This audio file has no sound track.');
    const audible = audio ? await audio.canDecode() : false;
    if (!video && !audible) throw new UnsupportedMediaError(`This browser can’t play this audio’s format (${audio?.codec ?? 'unknown codec'}).`);
    const seconds = await input.computeDuration();
    if (!(seconds > 0)) throw new UnsupportedMediaError('This file has no playable length.');
    return {
      durationMs: Math.round(seconds * 1000),
      width: video ? await video.getDisplayWidth() : undefined,
      height: video ? await video.getDisplayHeight() : undefined,
      hasAudio: audible,
    };
  } finally {
    input.dispose();
  }
}
