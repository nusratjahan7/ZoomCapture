import type { ExportFormat } from '@/types';

/**
 * What this browser can encode, and which pipeline each format uses.
 *
 * - **WebCodecs** (`VideoEncoder` / `AudioEncoder`, muxed by Mediabunny) is used for MP4 and WebM:
 *   frame-exact, faster than real time, and the same frames the preview draws. MP4 gets H.264
 *   (else HEVC, AV1 or VP9 in MP4) with AAC (else Opus in MP4), so the file is a real ISO MP4,
 *   whatever the browser's MediaRecorder writes.
 * - **MediaRecorder** is only probed and reported: it records in real time from a playing stream,
 *   so frame timing would depend on the machine keeping up, and its MP4 support varies by browser
 *   and version. It is never used to make an export.
 * - **FFmpeg.wasm** isn't bundled: it adds about 30 MB, runs several times slower than the
 *   hardware encoders WebCodecs uses, and would need a CSP exception for its worker. Everything it
 *   would do here is covered by WebCodecs, the GIF encoder (`gif/`) and canvas image encoding.
 * - **GIF** is encoded by ZoomCapture itself (palette + LZW, GIF89a, animated).
 * - **PNG / JPEG** use the canvas's own image encoder.
 */

export type VideoCodecId = 'avc' | 'hevc' | 'vp9' | 'av1' | 'vp8';
export type AudioCodecId = 'aac' | 'opus';

export interface ExportCapabilities {
  webCodecs: { video: boolean; audio: boolean };
  /** Encodable codecs, per container, best first (at a typical 1080p30). */
  mp4: { video: VideoCodecId[]; audio: AudioCodecId[] };
  webm: { video: VideoCodecId[]; audio: AudioCodecId[] };
  mediaRecorder: { available: boolean; mp4: boolean; webm: boolean };
  ffmpegWasm: { bundled: false };
  canvasImages: { png: boolean; jpeg: boolean };
  /** `showSaveFilePicker`: write straight to a chosen file. */
  fileSystemAccess: boolean;
}

export const CODEC_PREFERENCE = {
  mp4: { video: ['avc', 'hevc', 'av1', 'vp9'] as VideoCodecId[], audio: ['aac', 'opus'] as AudioCodecId[] },
  webm: { video: ['vp9', 'vp8', 'av1'] as VideoCodecId[], audio: ['opus'] as AudioCodecId[] },
};

export const CODEC_NAMES: Record<VideoCodecId | AudioCodecId, string> = {
  avc: 'H.264',
  hevc: 'HEVC (H.265)',
  vp9: 'VP9',
  vp8: 'VP8',
  av1: 'AV1',
  aac: 'AAC',
  opus: 'Opus',
};

export interface Pipeline {
  format: ExportFormat;
  engine: 'webcodecs' | 'gif-encoder' | 'canvas-image';
  videoCodec?: VideoCodecId;
  audioCodec?: AudioCodecId | null;
}

export class UnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFormatError';
  }
}

/**
 * The pipeline for a format from probed capabilities. Throws `UnsupportedFormatError` (with what
 * is missing and what to do) when the browser can't make it.
 */
export function choosePipeline(capabilities: ExportCapabilities, format: ExportFormat): Pipeline {
  if (format === 'gif') return { format, engine: 'gif-encoder' };
  if (format === 'png' || format === 'jpeg') {
    if (!capabilities.canvasImages[format]) throw new UnsupportedFormatError(`This browser can't encode ${format.toUpperCase()} images.`);
    return { format, engine: 'canvas-image' };
  }
  if (!capabilities.webCodecs.video) {
    throw new UnsupportedFormatError('This browser has no WebCodecs video encoder, so videos can’t be exported here. Use a current version of Chrome.');
  }
  const codecs = capabilities[format];
  const videoCodec = codecs.video[0];
  if (!videoCodec) {
    const other = format === 'mp4' ? 'WebM' : 'MP4';
    const alternative = capabilities[format === 'mp4' ? 'webm' : 'mp4'].video.length > 0 ? ` Export as ${other} instead.` : '';
    throw new UnsupportedFormatError(`This browser can't encode video for ${format.toUpperCase()} (tried ${CODEC_PREFERENCE[format].video.map((codec) => CODEC_NAMES[codec]).join(', ')}).${alternative}`);
  }
  return { format, engine: 'webcodecs', videoCodec, audioCodec: capabilities.webCodecs.audio ? (codecs.audio[0] ?? null) : null };
}

async function encodableVideo(codecs: VideoCodecId[]): Promise<VideoCodecId[]> {
  const { canEncodeVideo } = await import('mediabunny');
  const result: VideoCodecId[] = [];
  for (const codec of codecs) {
    // Checked at 1080p30; the export checks again at its own size (and steps down if refused).
    if (await canEncodeVideo(codec, { width: 1920, height: 1080, frameRate: 30 }).catch(() => false)) result.push(codec);
  }
  return result;
}

async function encodableAudio(codecs: AudioCodecId[]): Promise<AudioCodecId[]> {
  const { canEncodeAudio } = await import('mediabunny');
  const result: AudioCodecId[] = [];
  for (const codec of codecs) if (await canEncodeAudio(codec, { numberOfChannels: 2, sampleRate: 48_000 }).catch(() => false)) result.push(codec);
  return result;
}

function canvasEncodes(type: string): boolean {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    return canvas.toDataURL(type).startsWith(`data:${type}`);
  } catch {
    return false;
  }
}

let probed: Promise<ExportCapabilities> | null = null;

/** Probes once per page (the answers don't change while it is open). */
export function probeCapabilities(): Promise<ExportCapabilities> {
  probed ??= (async (): Promise<ExportCapabilities> => {
    const webCodecs = { video: typeof VideoEncoder !== 'undefined', audio: typeof AudioEncoder !== 'undefined' };
    const recorder = typeof MediaRecorder !== 'undefined';
    const [mp4Video, mp4Audio, webmVideo, webmAudio] = webCodecs.video
      ? await Promise.all([
          encodableVideo(CODEC_PREFERENCE.mp4.video),
          webCodecs.audio ? encodableAudio(CODEC_PREFERENCE.mp4.audio) : [],
          encodableVideo(CODEC_PREFERENCE.webm.video),
          webCodecs.audio ? encodableAudio(CODEC_PREFERENCE.webm.audio) : [],
        ])
      : [[], [], [], []];
    return {
      webCodecs,
      mp4: { video: mp4Video, audio: mp4Audio },
      webm: { video: webmVideo, audio: webmAudio },
      mediaRecorder: {
        available: recorder,
        mp4: recorder && MediaRecorder.isTypeSupported('video/mp4'),
        webm: recorder && MediaRecorder.isTypeSupported('video/webm'),
      },
      ffmpegWasm: { bundled: false as const },
      canvasImages: { png: canvasEncodes('image/png'), jpeg: canvasEncodes('image/jpeg') },
      fileSystemAccess: typeof (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function',
    };
  })().catch((error) => {
    probed = null;
    throw error;
  });
  return probed!;
}
