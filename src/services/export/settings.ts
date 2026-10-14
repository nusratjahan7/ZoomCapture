import type { Size } from '@/services/zoom/coordinates';
import type { ExportFormat, ExportFrameRate, ExportQuality, ExportSettings, GifExportSettings } from '@/types';
import { defaultExportSettings } from '@/services/storage/projectDefaults';
import { safeFileName } from './exporters';

/**
 * Export settings: defaults for older projects, validation, bitrates, size estimates and the
 * limits that keep an export within memory. Pure functions (unit-tested).
 */

export const VIDEO_FORMATS = ['mp4', 'webm'] as const;
export const STILL_FORMATS = ['png', 'jpeg'] as const;
export const isVideoFormat = (format: ExportFormat): format is 'mp4' | 'webm' => format === 'mp4' || format === 'webm';
export const isStillFormat = (format: ExportFormat): format is 'png' | 'jpeg' => format === 'png' || format === 'jpeg';

export const FRAME_RATES: readonly ExportFrameRate[] = [24, 25, 30, 60];
export const GIF_FRAME_RATES: ReadonlyArray<GifExportSettings['frameRate']> = [5, 10, 15, 20, 25];
export const GIF_SIZES = [320, 480, 640, 800, 960, 1280] as const;
export const GIF_COLORS: ReadonlyArray<GifExportSettings['colors']> = [64, 128, 256];

export const LIMITS = {
  /** Video bitrate with a custom quality (Mbps). */
  bitrateMbps: { min: 0.5, max: 100 },
  jpegQuality: { min: 0.5, max: 1 },
  /** GIFs are uncompressed-ish: bounded in frames and in total pixels. */
  gifMaxFrames: 1500,
  gifMaxPixels: 400_000_000,
  gifMaxSide: 1280,
  /** Still images: the largest side any browser canvas reliably supports. */
  stillMaxSide: 8192,
} as const;

export const DEFAULT_GIF: GifExportSettings = { size: 640, frameRate: 10, colors: 256, dither: true, loop: true, startMs: 0, endMs: null };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Stored settings with every field present and valid (older projects lack the newer fields). */
export function exportSettingsOf(stored: Partial<ExportSettings> | undefined): Required<Omit<ExportSettings, 'bitrateMbps'>> & { bitrateMbps: number } {
  const base = { ...defaultExportSettings(), ...stored };
  const gif = { ...DEFAULT_GIF, ...base.gif };
  const formats: ExportFormat[] = ['mp4', 'webm', 'gif', 'png', 'jpeg'];
  const qualities: ExportQuality[] = ['low', 'standard', 'high', 'custom'];
  return {
    ...base,
    format: formats.includes(base.format) ? base.format : 'mp4',
    frameRate: FRAME_RATES.includes(base.frameRate) ? base.frameRate : 30,
    quality: qualities.includes(base.quality) ? base.quality : 'high',
    bitrateMbps: clamp(Number(base.bitrateMbps) || 8, LIMITS.bitrateMbps.min, LIMITS.bitrateMbps.max),
    gif: {
      size: GIF_SIZES.includes(gif.size as (typeof GIF_SIZES)[number]) ? gif.size : DEFAULT_GIF.size,
      frameRate: GIF_FRAME_RATES.includes(gif.frameRate) ? gif.frameRate : DEFAULT_GIF.frameRate,
      colors: GIF_COLORS.includes(gif.colors) ? gif.colors : DEFAULT_GIF.colors,
      dither: Boolean(gif.dither),
      loop: gif.loop !== false,
      startMs: Math.max(0, Math.round(Number(gif.startMs) || 0)),
      endMs: gif.endMs === null || gif.endMs === undefined ? null : Math.max(0, Math.round(Number(gif.endMs))),
    },
    jpegQuality: clamp(Number(base.jpegQuality) || 0.92, LIMITS.jpegQuality.min, LIMITS.jpegQuality.max),
    fileName: base.fileName ?? '',
    saveTo: base.saveTo === 'choose' ? 'choose' : 'downloads',
  };
}

export type NormalizedExportSettings = ReturnType<typeof exportSettingsOf>;

/** Quality level (0-1) per preset, as Mediabunny's scale. */
const QUALITY_LEVEL: Record<Exclude<ExportQuality, 'custom'>, number> = { low: 0.25, standard: 0.5, high: 0.75 };

/** Codec efficiency relative to H.264 (Mediabunny's factors). */
const CODEC_EFFICIENCY: Record<string, number> = { avc: 1, hevc: 0.6, vp9: 0.6, av1: 0.4, vp8: 1.2 };

/**
 * Video bitrate (bits/s) for a quality preset: 3 Mbps for 1080p H.264 at medium, scaled by pixel
 * count, codec and level (the formula Mediabunny uses), so estimates match what is encoded.
 * 60 fps gets 1.5×. A custom quality is the user's bitrate.
 */
export function videoBitrate(settings: Pick<NormalizedExportSettings, 'quality' | 'bitrateMbps' | 'frameRate'>, size: Size, codec: string): number {
  if (settings.quality === 'custom') return Math.round(settings.bitrateMbps * 1_000_000);
  const pixels = size.width * size.height;
  const base = 3_000_000 * Math.pow(pixels / (1920 * 1080), 0.95);
  const factor = 0.3 * Math.exp(2.5538 * QUALITY_LEVEL[settings.quality]);
  const fps = settings.frameRate > 30 ? 1.5 : 1;
  return Math.max(100_000, Math.ceil((base * (CODEC_EFFICIENCY[codec] ?? 1) * factor * fps) / 1000) * 1000);
}

export function audioBitrate(quality: ExportQuality): number {
  return quality === 'low' ? 96_000 : quality === 'high' || quality === 'custom' ? 192_000 : 128_000;
}

/** The GIF's frame size: the output shape, its longest side at most `gif.size` (never upscaled). */
export function gifSize(frame: Size, gif: Pick<GifExportSettings, 'size'>): Size {
  const longest = Math.max(frame.width, frame.height);
  const scale = Math.min(1, Math.min(gif.size, LIMITS.gifMaxSide) / longest);
  return { width: Math.max(2, Math.round(frame.width * scale)), height: Math.max(2, Math.round(frame.height * scale)) };
}

/** The part of the timeline a GIF covers (ms), within the timeline. */
export function gifRange(gif: Pick<GifExportSettings, 'startMs' | 'endMs'>, durationMs: number): { startMs: number; endMs: number } {
  const startMs = clamp(gif.startMs, 0, Math.max(0, durationMs - 100));
  const endMs = clamp(gif.endMs ?? durationMs, startMs + 100, durationMs);
  return { startMs, endMs };
}

/** GIF frame delays are in hundredths of a second: the delay actually used for a frame rate. */
export const gifDelayCs = (frameRate: number) => Math.max(2, Math.round(100 / frameRate));

export function gifFrameCount(range: { startMs: number; endMs: number }, frameRate: number): number {
  return Math.max(1, Math.ceil(((range.endMs - range.startMs) / 1000) * (100 / gifDelayCs(frameRate)) - 1e-6));
}

/** What would make an export impossible or unreasonable, in words (null when fine). */
export function gifProblem(size: Size, frames: number): string | null {
  if (frames > LIMITS.gifMaxFrames) return `A GIF of ${frames} frames is too long (at most ${LIMITS.gifMaxFrames}). Shorten the part, or lower the frame rate.`;
  if (size.width * size.height * frames > LIMITS.gifMaxPixels) return 'This GIF would be too large to make in the browser. Make it smaller, shorter, or lower its frame rate.';
  return null;
}

/** A rough size estimate (bytes) for the summary, and to decide whether it fits in memory. */
export function estimateBytes(
  settings: NormalizedExportSettings,
  output: { size: Size; durationSeconds: number; videoCodec?: string; hasAudio: boolean; gifFrames?: number },
): number {
  const { size, durationSeconds } = output;
  if (isVideoFormat(settings.format)) {
    const video = videoBitrate(settings, size, output.videoCodec ?? (settings.format === 'mp4' ? 'avc' : 'vp9'));
    const audio = output.hasAudio ? audioBitrate(settings.quality) : 0;
    return Math.round(((video + audio) / 8) * durationSeconds * 1.02);
  }
  if (settings.format === 'gif') {
    // Screen content compresses well with frame differencing; this is a cautious middle.
    const perFrame = size.width * size.height * (settings.gif.dither ? 0.35 : 0.22);
    return Math.round(size.width * size.height * 0.6 + perFrame * Math.max(0, (output.gifFrames ?? 1) - 1));
  }
  const pixels = size.width * size.height;
  return Math.round(settings.format === 'png' ? pixels * 1.2 : pixels * (0.15 + 0.45 * settings.jpegQuality));
}

/**
 * The most a finished export may take in memory before it is saved (Downloads mode keeps the
 * whole file until the download starts): a quarter of the device memory Chrome reports, between
 * 512 MB and 2 GB. Larger exports are written straight to a file the user chooses instead.
 */
export function memoryBudgetBytes(deviceMemoryGb = (globalThis.navigator as Navigator & { deviceMemory?: number } | undefined)?.deviceMemory ?? 8): number {
  const quarter = (deviceMemoryGb * 1024 ** 3) / 4;
  return Math.round(clamp(quarter, 512 * 1024 ** 2, 2 * 1024 ** 3));
}

export const EXTENSIONS: Record<ExportFormat, string> = { mp4: 'mp4', webm: 'webm', gif: 'gif', png: 'png', jpeg: 'jpg' };
export const MIME_TYPES: Record<ExportFormat, string> = { mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif', png: 'image/png', jpeg: 'image/jpeg' };

/** The file name: the chosen name (or the recording's), safe on every system, with the format's extension. */
export function exportFileName(name: string, recordingName: string, format: ExportFormat, suffix = ''): string {
  const extension = EXTENSIONS[format];
  // A name typed with its own extension (any of ours) doesn't get a second one.
  const base = safeFileName(name.trim().replace(/\.(mp4|webm|gif|png|jpe?g)$/i, '') || `${recordingName}${suffix}`);
  return `${base}.${extension}`;
}
