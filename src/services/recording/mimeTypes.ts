/**
 * Container/codec selection for MediaRecorder. Candidates are checked with
 * `MediaRecorder.isTypeSupported()` in order of preference; the first supported one is used.
 * WebM is preferred: Chrome supports it on every platform, it survives pause/resume cleanly, and
 * the export module transcodes to MP4 when asked (see services/export).
 */
const CANDIDATES = {
  'video+audio': [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
  ],
  video: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm;codecs=h264', 'video/webm'],
  audio: ['audio/webm;codecs=opus', 'audio/webm'],
} as const;

export type RecordingContent = keyof typeof CANDIDATES;

export function findSupportedMimeType(content: RecordingContent): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return CANDIDATES[content].find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export function pickMimeType(content: RecordingContent): string {
  const type = findSupportedMimeType(content);
  if (!type) throw new Error(`This browser cannot record ${content === 'audio' ? 'audio' : 'video'} with MediaRecorder.`);
  return type;
}

const CODEC_NAMES: Record<string, string> = { vp9: 'VP9', vp8: 'VP8', h264: 'H.264', avc1: 'H.264', opus: 'Opus' };

/** "video/webm;codecs=vp9,opus" → "WebM · VP9 + Opus". */
export function describeMimeType(mimeType: string): string {
  const [container = '', params = ''] = mimeType.split(';');
  const format = container.split('/')[1]?.toUpperCase().replace('WEBM', 'WebM') ?? container;
  const codecs = /codecs=([^;]+)/.exec(params)?.[1]?.split(',') ?? [];
  const names = codecs.map((codec) => CODEC_NAMES[codec.trim().split('.')[0]!.toLowerCase()] ?? codec.trim());
  return names.length ? `${format} · ${names.join(' + ')}` : format;
}

export function fileExtension(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  return 'bin';
}

export function isWebm(mimeType: string): boolean {
  return mimeType.includes('webm');
}

/** Target video bitrate: ~0.12 bits per pixel per frame, clamped to a sensible range. */
export function videoBitrate(width = 1920, height = 1080, frameRate = 30): number {
  return Math.round(Math.min(40_000_000, Math.max(2_500_000, width * height * frameRate * 0.12)));
}

export const AUDIO_BITRATE = 128_000;
export const CAMERA_BITRATE = 2_500_000;
