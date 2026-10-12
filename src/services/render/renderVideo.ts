import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  canEncodeAudio,
  CanvasSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  getFirstEncodableVideoCodec,
  Input,
  Output,
  Quality,
  VideoSampleSink,
  WebMOutputFormat,
  type InputAudioTrack,
  type VideoCodec,
  type VideoSample,
} from 'mediabunny';
import { safeFileName } from '@/services/export/exporters';
import type { Size } from '@/services/zoom/coordinates';
import type { CameraLayout, ExportSettings, MediaAsset, Project, Recording } from '@/types';
import { drawFrame, type FrameImage } from './draw';
import { frameStateAt, renderEffectsOf, type RenderScene } from './frameState';
import { fallbackSizes, frameTimestamps, outputSize } from './output';

/**
 * Renders a recording with its zoom effects into a new WebM file. The original recording is only
 * read, never changed.
 *
 * Pipeline (WebCodecs via Mediabunny, faster than real time and frame-exact):
 *   demux + decode the screen video → for each output frame at time t, take the latest source
 *   frame and draw it with `drawFrame(frameStateAt(scene, t))` — the same code the preview uses —
 *   → encode (VP9, else VP8 or AV1) → mux. The audio packets are copied unchanged with their
 *   original timestamps (re-encoded to Opus only if the source codec can't go into WebM), so
 *   audio stays in sync with the video exactly as in the original.
 */

export type RenderSettings = Pick<ExportSettings, 'resolution' | 'frameRate' | 'quality' | 'includeCamera'>;

export interface RenderJob {
  recording: Recording;
  project: Project;
  assets: MediaAsset[];
  screen: Blob;
  /** The camera track, when it should be drawn as a bubble. */
  camera?: Blob;
}

export interface RenderProgress {
  frame: number;
  frames: number;
  /** 0-1. */
  fraction: number;
}

export interface RenderResult {
  blob: Blob;
  fileName: string;
  width: number;
  height: number;
  frameRate: number;
  frames: number;
  durationSeconds: number;
  videoCodec: VideoCodec;
  audio: 'copied' | 're-encoded' | 'none';
  /** Things the user should know about the result (e.g. a lower resolution was used). */
  warnings: string[];
}

export class RenderError extends Error {
  constructor(
    message: string,
    readonly reason: 'no-video' | 'unsupported-source' | 'unsupported-encoder' | 'failed',
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

const VIDEO_CODECS: VideoCodec[] = ['vp9', 'vp8', 'av1'];

export function sceneFor(recording: Recording, project: Project): RenderScene {
  return {
    markers: project.timeline.zoomMarkers,
    clicks: recording.interactions,
    cursor: recording.cursor ?? [],
    effects: renderEffectsOf(project),
    zoom: true,
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Rendering was cancelled.', 'AbortError');
}

/** Picks the output size and codec, stepping down in size when the encoder rejects it. */
export async function chooseEncoding(source: Size, settings: RenderSettings, quality: Quality, warnings: string[]): Promise<{ size: Size; codec: VideoCodec }> {
  const requested = outputSize(source, settings.resolution);
  for (const size of [requested, ...fallbackSizes(source, requested)]) {
    const codec = await getFirstEncodableVideoCodec(VIDEO_CODECS, { ...size, quality, frameRate: settings.frameRate });
    if (!codec) continue;
    if (size !== requested) {
      warnings.push(`This browser can't encode ${requested.width}×${requested.height} video, so it was rendered at ${size.width}×${size.height}.`);
    }
    return { size, codec };
  }
  throw new RenderError("This browser can't encode WebM video (VP9, VP8 or AV1), so the video can't be rendered here.", 'unsupported-encoder');
}

/** Sets up the audio track: copied as-is when WebM can hold it, otherwise re-encoded to Opus. */
async function prepareAudio(
  track: InputAudioTrack | null,
  output: Output,
  warnings: string[],
  signal?: AbortSignal,
): Promise<{ mode: RenderResult['audio']; pump: () => Promise<void> }> {
  if (!track) return { mode: 'none', pump: async () => undefined };
  const codec = track.codec;
  if (codec === 'opus' || codec === 'vorbis') {
    const source = new EncodedAudioPacketSource(codec);
    output.addAudioTrack(source);
    const decoderConfig = await track.getDecoderConfig();
    return {
      mode: 'copied',
      pump: async () => {
        let first = true;
        for await (const packet of new EncodedPacketSink(track).packets()) {
          throwIfAborted(signal);
          await source.add(packet, first && decoderConfig ? { decoderConfig } : undefined);
          first = false;
        }
        source.close();
      },
    };
  }
  if ((await track.canDecode()) && (await canEncodeAudio('opus'))) {
    const source = new AudioSampleSource({ codec: 'opus', bitrate: 160_000 });
    output.addAudioTrack(source);
    return {
      mode: 're-encoded',
      pump: async () => {
        for await (const sample of new AudioSampleSink(track).samples()) {
          try {
            throwIfAborted(signal);
            await source.add(sample);
          } finally {
            sample.close();
          }
        }
        source.close();
      },
    };
  }
  warnings.push(`The recording's audio (${codec ?? 'unknown codec'}) can't be processed by this browser, so the rendered video has no sound.`);
  return { mode: 'none', pump: async () => undefined };
}

/** The part of a decoded frame `heldFrames` needs (VideoSample satisfies it). */
export interface HoldableFrame {
  readonly timestamp: number;
  clone(): this;
  close(): void;
}

/**
 * For each output time, the latest source frame at or before it (the first frame before that),
 * from frames decoded in order. Yields a clone the caller must close.
 *
 * Decoding sequentially (instead of seeking for every timestamp) matters for screen recordings:
 * a still screen produces long stretches without keyframes, and random access into such files
 * without a cue index is unreliable. It is also cheaper: every packet is decoded exactly once.
 */
export async function* heldFrames<T extends HoldableFrame>(frames: AsyncIterator<T>, times: Iterable<number>): AsyncGenerator<T | null> {
  let current: T | null = null;
  let next = await frames.next();
  try {
    for (const time of times) {
      while (!next.done && next.value.timestamp <= time + 1e-6) {
        current?.close();
        current = next.value;
        next = await frames.next();
      }
      const shown = current ?? (next.done ? null : next.value);
      yield shown ? shown.clone() : null;
    }
  } finally {
    current?.close();
    if (!next.done) next.value.close();
    await frames.return?.(undefined);
  }
}

const frameImage = (sample: VideoSample | null | undefined): FrameImage | null =>
  sample ? { image: sample.toCanvasImageSource(), width: sample.displayWidth, height: sample.displayHeight } : null;

export async function renderRecording(
  job: RenderJob,
  settings: RenderSettings,
  options: { signal?: AbortSignal; onProgress?: (progress: RenderProgress) => void } = {},
): Promise<RenderResult> {
  const { signal, onProgress } = options;
  const warnings: string[] = [];
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(job.screen) });
  const cameraInput = job.camera ? new Input({ formats: ALL_FORMATS, source: new BlobSource(job.camera) }) : null;
  let output: Output | null = null;

  try {
    if (!(await input.canRead())) throw new RenderError("The recording's file format can't be read for rendering.", 'unsupported-source');
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new RenderError('The recording has no video to render.', 'no-video');
    if (!(await videoTrack.canDecode())) {
      throw new RenderError(`This browser can't decode the recording's video (${videoTrack.codec ?? 'unknown codec'}).`, 'unsupported-source');
    }
    const source = { width: await videoTrack.getDisplayWidth(), height: await videoTrack.getDisplayHeight() };
    const durationSeconds = await input.computeDuration();
    const quality = new Quality(settings.quality === 'high' ? 'high' : 'medium');
    const { size, codec } = await chooseEncoding(source, settings, quality, warnings);
    throwIfAborted(signal);

    // Camera bubble: drawn only when the camera can be decoded; otherwise the video renders without it.
    let cameraSink: VideoSampleSink | null = null;
    const cameraLayout: CameraLayout | undefined = settings.includeCamera ? job.project.cameraLayout : undefined;
    const cameraAsset = job.assets.find((asset) => asset.kind === 'camera' && asset.origin === 'recording');
    if (cameraInput && cameraLayout) {
      const cameraTrack = await cameraInput.getPrimaryVideoTrack();
      if (cameraTrack && (await cameraTrack.canDecode())) {
        cameraSink = new VideoSampleSink(cameraTrack);
      } else {
        warnings.push("The camera video can't be decoded by this browser, so it is not included.");
      }
    }
    const cameraOffset = (cameraAsset?.startOffsetMs ?? 0) / 1000;

    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new RenderError('Could not create a drawing surface for rendering.', 'failed');

    output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
    const videoSource = new CanvasSource(canvas, { codec, quality, keyFrameInterval: 2 });
    output.addVideoTrack(videoSource, { frameRate: settings.frameRate });
    const audio = await prepareAudio(await input.getPrimaryAudioTrack(), output, warnings, signal);
    await output.start();

    const times = frameTimestamps(durationSeconds, settings.frameRate);
    const scene = sceneFor(job.recording, job.project);
    const screenFrames = heldFrames(new VideoSampleSink(videoTrack).samples(), times);
    const cameraFrames = cameraSink ? heldFrames(cameraSink.samples(), times.map((t) => t - cameraOffset)) : null;

    const pumpVideo = async () => {
      let index = 0;
      try {
        for await (const screen of screenFrames) {
          const camera = cameraFrames ? ((await cameraFrames.next()).value ?? null) : null;
          const timestamp = times[index]!;
          try {
            throwIfAborted(signal);
            drawFrame(
              ctx,
              size.width,
              size.height,
              { screen: frameImage(screen), camera: frameImage(camera), cameraLayout },
              frameStateAt(scene, timestamp * 1000),
            );
          } finally {
            screen?.close();
            camera?.close();
          }
          await videoSource.add(timestamp, 1 / settings.frameRate);
          index += 1;
          onProgress?.({ frame: index, frames: times.length, fraction: index / times.length });
        }
      } finally {
        await screenFrames.return(undefined);
        await cameraFrames?.return(undefined);
      }
      videoSource.close();
    };

    await Promise.all([pumpVideo(), audio.pump()]);
    throwIfAborted(signal);
    await output.finalize();
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new RenderError('The rendered video is empty.', 'failed');
    return {
      blob: new Blob([buffer], { type: await output.getMimeType() }),
      fileName: `${safeFileName(job.recording.name)} (zoom).webm`,
      width: size.width,
      height: size.height,
      frameRate: settings.frameRate,
      frames: times.length,
      durationSeconds,
      videoCodec: codec,
      audio: audio.mode,
      warnings,
    };
  } catch (error) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => undefined);
    throw error;
  } finally {
    input.dispose();
    cameraInput?.dispose();
  }
}
