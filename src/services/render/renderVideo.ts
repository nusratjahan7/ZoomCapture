import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  canEncodeAudio,
  CanvasSource,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  WebMOutputFormat,
  type AudioCodec,
  type StreamTargetChunk,
  type VideoCodec,
} from 'mediabunny';
import { safeFileName } from '@/services/export/exporters';
import { MemoryLimitError } from '@/services/export/saveTarget';
import { audioBitrate, videoBitrate } from '@/services/export/settings';
import { clipDuration, contentDuration } from '@/services/timeline/model';
import type { Size } from '@/services/zoom/coordinates';
import type { ExportFrameRate, ExportQuality, ExportResolution, MediaClip } from '@/types';
import { audibleClips, gainPoints } from './audioMix';
import { frameSize } from './compose';
import { createFrameRenderer, RenderError, throwIfAborted, type RenderJob } from './frameRenderer';
import { frameTimestamps } from './output';

export { FrameCursor, RenderError, type HoldableFrame, type RenderJob } from './frameRenderer';
export { audibleClips } from './audioMix';

/**
 * Renders the edited timeline into a new MP4 or WebM file. The original recording and imported
 * files are only read, never changed.
 *
 * Video (WebCodecs via Mediabunny, faster than real time, frame-exact): for each output frame at
 * timeline time t, `createFrameRenderer` draws every visible clip at its own source time — the
 * same `drawFrame` the editor preview uses — and the canvas is encoded: H.264 (else HEVC, AV1,
 * VP9) in MP4, VP9 (else VP8, AV1) in WebM.
 * Audio: every audible clip is mixed at its timeline position with its volume and fades (Web
 * Audio, rendered offline in 30-second windows to bound memory), then encoded to AAC (MP4, else
 * Opus) or Opus (WebM).
 * Output: kept in memory (then downloaded), or written as it is made to a file the user chose
 * (`target`), so long videos don't have to fit in memory.
 */

export interface RenderSettings {
  resolution: ExportResolution;
  frameRate: ExportFrameRate | number;
  quality: ExportQuality;
  bitrateMbps?: number;
  includeCamera: boolean;
  /** Defaults to WebM. */
  container?: 'mp4' | 'webm';
}

export interface RenderProgress {
  frame: number;
  frames: number;
  /** 0-1. */
  fraction: number;
  stage?: 'preparing' | 'rendering' | 'finalizing';
}

export interface RenderResult {
  /** The file (null when it was written to `target`). */
  blob: Blob | null;
  bytes: number;
  mimeType: string;
  fileName: string;
  width: number;
  height: number;
  frameRate: number;
  frames: number;
  durationSeconds: number;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec | null;
  videoBitrate: number;
  audio: 'mixed' | 'none';
  /** Things the user should know about the result (e.g. a lower resolution was used). */
  warnings: string[];
}

export interface RenderOptions {
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
  /** Write here as the file is made (a file the user chose) instead of keeping it in memory. */
  target?: WritableStream<StreamTargetChunk>;
  /** In memory: stop with a clear error if the file grows past this (bytes). */
  maxBytes?: number;
  /** Called when every frame is encoded, just before the file is completed (keep the file from here). */
  onBeforeFinalize?: () => void;
}

const CODECS: Record<'mp4' | 'webm', { video: VideoCodec[]; audio: AudioCodec[] }> = {
  mp4: { video: ['avc', 'hevc', 'av1', 'vp9'], audio: ['aac', 'opus'] },
  webm: { video: ['vp9', 'vp8', 'av1'], audio: ['opus'] },
};
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
/** Audio is mixed in windows of this length, so memory does not grow with the video's length. */
const AUDIO_WINDOW_SECONDS = 30;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** Picks the output size and codec, stepping down in size when the encoder rejects it. */
export async function chooseEncoding(
  requested: Size,
  frameRate: number,
  quality: Quality,
  warnings: string[],
  container: 'mp4' | 'webm' = 'webm',
): Promise<{ size: Size; codec: VideoCodec }> {
  const short = Math.min(requested.width, requested.height);
  const smaller = [1440, 1080, 720, 480]
    .filter((side) => side < short)
    .map((side) => ({ width: even((requested.width * side) / short), height: even((requested.height * side) / short) }));
  for (const size of [requested, ...smaller]) {
    const codec = await getFirstEncodableVideoCodec(CODECS[container].video, { ...size, quality, frameRate });
    if (!codec) continue;
    if (size !== requested) {
      warnings.push(`This browser can't encode ${requested.width}×${requested.height} video, so it was rendered at ${size.width}×${size.height}.`);
    }
    return { size, codec };
  }
  const names = container === 'mp4' ? 'H.264, HEVC, AV1 or VP9' : 'VP9, VP8 or AV1';
  throw new RenderError(`This browser can't encode ${container === 'mp4' ? 'MP4' : 'WebM'} video (${names}), so the video can't be rendered here.`, 'unsupported-encoder');
}

/**
 * Where a clip's sound goes in one mixing window (seconds): `when` in the window, from `offset`
 * in its file, for `duration`. Null if the clip isn't heard in that window. A clip spanning two
 * windows continues exactly where it stopped, so long voiceovers stay in sync.
 */
export function audioPlacement(clip: MediaClip, windowStart: number, windowEnd: number): { when: number; offset: number; duration: number } | null {
  const start = clip.startMs / 1000;
  const end = start + clipDuration(clip) / 1000;
  if (end <= windowStart || start >= windowEnd) return null;
  return {
    when: Math.max(0, start - windowStart),
    offset: clip.sourceInMs / 1000 + Math.max(0, windowStart - start),
    duration: Math.min(end, windowEnd) - Math.max(start, windowStart),
  };
}

/**
 * Mixes the timeline's audio window by window with OfflineAudioContext and yields samples ready
 * to encode. Returns null when nothing is audible (or no audio codec is available).
 */
async function prepareAudioMix(
  job: RenderJob,
  durationSeconds: number,
  warnings: string[],
  signal?: AbortSignal,
): Promise<AsyncGenerator<AudioSample> | null> {
  const assetMap = new Map(job.assets.map((asset) => [asset.id, asset]));
  const clips = audibleClips(job.project.timeline, assetMap);
  if (clips.length === 0 || typeof OfflineAudioContext === 'undefined') return null;
  const decoder = new OfflineAudioContext(CHANNELS, 1, SAMPLE_RATE);
  const buffers = new Map<string, AudioBuffer>();
  for (const { asset } of clips) {
    if (buffers.has(asset.id)) continue;
    const blob = job.blobs.get(asset.id);
    try {
      if (!blob) throw new Error('missing');
      buffers.set(asset.id, await decoder.decodeAudioData(await blob.arrayBuffer()));
    } catch {
      warnings.push(`The sound of “${asset.label ?? asset.kind}” couldn't be decoded, so it is not in the exported video.`);
    }
    throwIfAborted(signal);
  }
  if (buffers.size === 0) return null;

  return (async function* () {
    try {
      for (let windowStart = 0; windowStart < durationSeconds; windowStart += AUDIO_WINDOW_SECONDS) {
        throwIfAborted(signal);
        const windowEnd = Math.min(durationSeconds, windowStart + AUDIO_WINDOW_SECONDS);
        const frames = Math.max(1, Math.round((windowEnd - windowStart) * SAMPLE_RATE));
        const context = new OfflineAudioContext(CHANNELS, frames, SAMPLE_RATE);
        for (const { clip, track } of clips) {
          const buffer = buffers.get(clip.assetId);
          if (!buffer) continue;
          const placement = audioPlacement(clip, windowStart, windowEnd);
          if (!placement || placement.offset >= buffer.duration) continue;
          const node = context.createBufferSource();
          node.buffer = buffer;
          // Volume, track volume and fades, as straight-line automation (see audioMix.ts).
          const gain = context.createGain();
          const points = gainPoints(clip, track, windowStart, windowEnd);
          gain.gain.setValueAtTime(points[0]?.[1] ?? 0, Math.max(0, points[0]?.[0] ?? 0));
          for (const [time, value] of points.slice(1)) gain.gain.linearRampToValueAtTime(value, time);
          node.connect(gain).connect(context.destination);
          node.start(placement.when, placement.offset, placement.duration);
        }
        const mixed = await context.startRendering();
        const data = new Float32Array(mixed.length * CHANNELS);
        for (let channel = 0; channel < CHANNELS; channel++) data.set(mixed.getChannelData(Math.min(channel, mixed.numberOfChannels - 1)), channel * mixed.length);
        yield new AudioSample({ data, format: 'f32-planar', numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE, timestamp: windowStart });
      }
    } finally {
      // Decoded sources can be large: dropped as soon as the mix is done (or abandoned).
      buffers.clear();
    }
  })();
}

/** The first audio codec this browser encodes for the container (null: the video has no sound). */
async function chooseAudioCodec(container: 'mp4' | 'webm'): Promise<AudioCodec | null> {
  for (const codec of CODECS[container].audio) if (await canEncodeAudio(codec, { numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE }).catch(() => false)) return codec;
  return null;
}

export async function renderProject(job: RenderJob, settings: RenderSettings, options: RenderOptions = {}): Promise<RenderResult> {
  const { signal, onProgress, target, maxBytes, onBeforeFinalize } = options;
  const container = settings.container ?? 'webm';
  const warnings: string[] = [];
  const durationSeconds = contentDuration(job.project.timeline.tracks) / 1000;
  if (durationSeconds <= 0) throw new RenderError('The timeline is empty: add a clip to render a video.', 'no-video');
  onProgress?.({ frame: 0, frames: 0, fraction: 0, stage: 'preparing' });

  const renderer = await createFrameRenderer(job, { includeCamera: settings.includeCamera, signal, warnings });
  let output: Output | null = null;
  try {
    const qualitySettings = { quality: settings.quality, bitrateMbps: settings.bitrateMbps ?? 8, frameRate: settings.frameRate as ExportFrameRate };
    const requested = frameSize(renderer.source, job.project.aspectRatio, settings.resolution, job.project.customSize);
    const probeQuality = new Quality({ bitrate: videoBitrate(qualitySettings, requested, 'avc') });
    const { size, codec } = await chooseEncoding(requested, settings.frameRate, probeQuality, warnings, container);
    const bitrate = videoBitrate(qualitySettings, size, codec);
    throwIfAborted(signal);
    const canvas = await renderer.start(size);

    output = new Output({
      // In memory: metadata first (plays while downloading, everywhere). Streamed to a file:
      // metadata at the end, so nothing has to be held back in memory.
      format: container === 'mp4' ? new Mp4OutputFormat({ fastStart: target ? false : 'in-memory' }) : new WebMOutputFormat(),
      target: target ? new StreamTarget(target, { chunked: true }) : new BufferTarget(),
    });
    // Counted as packets come out of the encoders; checked between frames (not thrown inside the encoder's callback).
    let encodedBytes = 0;
    const countBytes = (bytes: number) => (encodedBytes += bytes);
    const checkSize = () => {
      if (!target && maxBytes && encodedBytes > maxBytes) throw new MemoryLimitError(maxBytes);
    };
    const videoSource = new CanvasSource(canvas, {
      codec,
      bitrate: new Quality({ bitrate, bitrateMode: 'variable' }),
      keyFrameInterval: 2,
      onEncodedPacket: (packet) => countBytes(packet.byteLength),
    });
    output.addVideoTrack(videoSource, { frameRate: settings.frameRate });
    const audioCodec = await chooseAudioCodec(container);
    const audioSamples = audioCodec ? await prepareAudioMix(job, durationSeconds, warnings, signal) : null;
    if (!audioCodec && audibleClips(job.project.timeline, new Map(job.assets.map((asset) => [asset.id, asset]))).length > 0) {
      warnings.push(`This browser can't encode audio for ${container.toUpperCase()}, so the exported video has no sound.`);
    }
    const audioSource =
      audioSamples && audioCodec
        ? new AudioSampleSource({ codec: audioCodec, bitrate: new Quality({ bitrate: audioBitrate(settings.quality) }), onEncodedPacket: (packet) => countBytes(packet.byteLength) })
        : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();

    const times = frameTimestamps(durationSeconds, settings.frameRate);
    // When one side fails, the other stops at its next frame or sample; both finish before the
    // renderer is closed, so no frame is still being decoded while it is released.
    let stopped = false;
    const pumpVideo = async () => {
      for (const [index, timestamp] of times.entries()) {
        if (stopped) return;
        throwIfAborted(signal);
        checkSize();
        await renderer.render(timestamp * 1000);
        await videoSource.add(timestamp, 1 / settings.frameRate);
        onProgress?.({ frame: index + 1, frames: times.length, fraction: (index + 1) / times.length, stage: 'rendering' });
      }
      videoSource.close();
    };
    const pumpAudio = async () => {
      if (!audioSamples || !audioSource) return;
      for await (const sample of audioSamples) {
        try {
          if (stopped) return;
          throwIfAborted(signal);
          await audioSource.add(sample);
        } finally {
          sample.close();
        }
      }
      audioSource.close();
    };

    const pumps = await Promise.allSettled(
      [pumpVideo(), pumpAudio()].map((pump) =>
        pump.catch((error: unknown) => {
          stopped = true;
          throw error;
        }),
      ),
    );
    const failure = pumps.find((pump) => pump.status === 'rejected');
    if (failure) throw failure.reason;
    throwIfAborted(signal);
    checkSize();
    onProgress?.({ frame: times.length, frames: times.length, fraction: 1, stage: 'finalizing' });
    onBeforeFinalize?.();
    await output.finalize();
    const mimeType = await output.getMimeType();
    let blob: Blob | null = null;
    let bytes = encodedBytes;
    if (!target) {
      const buffer = (output.target as BufferTarget).buffer;
      if (!buffer || buffer.byteLength === 0) throw new RenderError('The exported video is empty.', 'failed');
      blob = new Blob([buffer], { type: mimeType });
      bytes = blob.size;
    }
    return {
      blob,
      bytes,
      mimeType,
      fileName: `${safeFileName(job.recording.name)} (edited).${container}`,
      width: size.width,
      height: size.height,
      frameRate: settings.frameRate,
      frames: times.length,
      durationSeconds,
      videoCodec: codec,
      audioCodec: audioSource ? audioCodec : null,
      videoBitrate: bitrate,
      audio: audioSource ? 'mixed' : 'none',
      warnings,
    };
  } catch (error) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => undefined);
    throw error;
  } finally {
    await renderer.close();
  }
}
