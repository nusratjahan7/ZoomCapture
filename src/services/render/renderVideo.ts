import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  canEncodeAudio,
  CanvasSource,
  getFirstEncodableVideoCodec,
  Input,
  Output,
  Quality,
  VideoSampleSink,
  WebMOutputFormat,
  type InputVideoTrack,
  type VideoCodec,
  type VideoSample,
} from 'mediabunny';
import { safeFileName } from '@/services/export/exporters';
import { clipDuration, contentDuration, isMediaClip } from '@/services/timeline/model';
import type { Size } from '@/services/zoom/coordinates';
import type { ExportSettings, MediaAsset, MediaClip, Project, Recording, Timeline } from '@/types';
import { activeVisuals, contentRect, frameSize, timelineScene } from './compose';
import { drawFrame, type FrameImage } from './draw';
import { frameStateAt } from './frameState';
import { frameTimestamps } from './output';

/**
 * Renders the edited timeline into a new WebM file. The original recording and imported files are
 * only read, never changed.
 *
 * Video (WebCodecs via Mediabunny, faster than real time, frame-exact): for each output frame at
 * timeline time t, every visible clip contributes the source frame at its own source time, and
 * `drawFrame(frameStateAt(scene, t))` composes them — the same code the editor preview uses —
 * then VP9 (else VP8 or AV1) encodes it.
 * Audio: every audible clip is mixed at its timeline position with its volume (Web Audio,
 * rendered offline in windows to bound memory), then encoded to Opus.
 */

export type RenderSettings = Pick<ExportSettings, 'resolution' | 'frameRate' | 'quality' | 'includeCamera'>;

export interface RenderJob {
  recording: Recording;
  project: Project;
  assets: readonly MediaAsset[];
  /** Stored bytes of every asset used on the timeline. */
  blobs: ReadonlyMap<string, Blob>;
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
  audio: 'mixed' | 'none';
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
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
/** Audio is mixed in windows of this length, so memory does not grow with the video's length. */
const AUDIO_WINDOW_SECONDS = 30;

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Rendering was cancelled.', 'AbortError');
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** Picks the output size and codec, stepping down in size when the encoder rejects it. */
export async function chooseEncoding(requested: Size, frameRate: number, quality: Quality, warnings: string[]): Promise<{ size: Size; codec: VideoCodec }> {
  const short = Math.min(requested.width, requested.height);
  const smaller = [1440, 1080, 720, 480]
    .filter((side) => side < short)
    .map((side) => ({ width: even((requested.width * side) / short), height: even((requested.height * side) / short) }));
  for (const size of [requested, ...smaller]) {
    const codec = await getFirstEncodableVideoCodec(VIDEO_CODECS, { ...size, quality, frameRate });
    if (!codec) continue;
    if (size !== requested) {
      warnings.push(`This browser can't encode ${requested.width}×${requested.height} video, so it was rendered at ${size.width}×${size.height}.`);
    }
    return { size, codec };
  }
  throw new RenderError("This browser can't encode WebM video (VP9, VP8 or AV1), so the video can't be rendered here.", 'unsupported-encoder');
}

/** The part of a decoded frame a `FrameCursor` needs (VideoSample satisfies it). */
export interface HoldableFrame {
  readonly timestamp: number;
  clone(): this;
  close(): void;
}

/**
 * Serves "the latest frame at or before time t" from frames decoded in order (the first frame for
 * times before it). Requests that go forward in time continue decoding; a request that goes back
 * (a clip that shows earlier source after a later one) restarts from the beginning.
 *
 * Decoding in order instead of seeking matters for screen recordings: a still screen produces long
 * stretches without keyframes, and random access into such files without a cue index proved
 * unreliable. Every frame returned is a clone the caller must close.
 */
export class FrameCursor<T extends HoldableFrame> {
  private iterator: AsyncIterator<T> | null = null;
  private current: T | null = null;
  private next: IteratorResult<T> | null = null;
  private last = Number.NEGATIVE_INFINITY;
  restarts = 0;

  constructor(private readonly open: () => AsyncIterator<T>) {}

  async frameAt(seconds: number): Promise<T | null> {
    if (!this.iterator || seconds < this.last - 1e-6) await this.restart();
    this.last = seconds;
    while (this.next && !this.next.done && this.next.value.timestamp <= seconds + 1e-6) {
      this.current?.close();
      this.current = this.next.value;
      this.next = await this.iterator!.next();
    }
    const shown = this.current ?? (this.next && !this.next.done ? this.next.value : null);
    return shown ? shown.clone() : null;
  }

  async close(): Promise<void> {
    this.current?.close();
    this.current = null;
    if (this.next && !this.next.done) this.next.value.close();
    this.next = null;
    await this.iterator?.return?.(undefined);
    this.iterator = null;
  }

  private async restart() {
    if (this.iterator) this.restarts += 1;
    await this.close();
    this.iterator = this.open();
    this.next = await this.iterator.next();
  }
}

const frameImage = (sample: VideoSample | null | undefined): FrameImage | null =>
  sample ? { image: sample.toCanvasImageSource(), width: sample.displayWidth, height: sample.displayHeight } : null;

/** Media clips whose sound is heard, with their asset (skips muted tracks and clips, images, silent media). */
export function audibleClips(timeline: Timeline, assets: ReadonlyMap<string, MediaAsset>): Array<{ clip: MediaClip; asset: MediaAsset }> {
  const result: Array<{ clip: MediaClip; asset: MediaAsset }> = [];
  for (const track of timeline.tracks) {
    if (track.muted || !(track.kind === 'video' || track.kind === 'audio' || track.kind === 'music')) continue;
    for (const clip of track.clips) {
      if (!isMediaClip(clip) || clip.muted || (clip.volume ?? 1) <= 0) continue;
      const asset = assets.get(clip.assetId);
      if (!asset || asset.kind === 'image' || asset.hasAudio === false) continue;
      result.push({ clip, asset });
    }
  }
  return result;
}

/**
 * Mixes the timeline's audio window by window with OfflineAudioContext and yields Opus-ready
 * samples. Returns null when nothing is audible.
 */
async function prepareAudioMix(
  job: RenderJob,
  durationSeconds: number,
  assetMap: ReadonlyMap<string, MediaAsset>,
  warnings: string[],
  signal?: AbortSignal,
): Promise<AsyncGenerator<AudioSample> | null> {
  const clips = audibleClips(job.project.timeline, assetMap);
  if (clips.length === 0 || typeof OfflineAudioContext === 'undefined') return null;
  if (!(await canEncodeAudio('opus'))) {
    warnings.push("This browser can't encode Opus audio, so the rendered video has no sound.");
    return null;
  }
  const decoder = new OfflineAudioContext(CHANNELS, 1, SAMPLE_RATE);
  const buffers = new Map<string, AudioBuffer>();
  for (const { asset } of clips) {
    if (buffers.has(asset.id)) continue;
    const blob = job.blobs.get(asset.id);
    try {
      if (!blob) throw new Error('missing');
      buffers.set(asset.id, await decoder.decodeAudioData(await blob.arrayBuffer()));
    } catch {
      warnings.push(`The sound of “${asset.label ?? asset.kind}” couldn't be decoded, so it is not in the rendered video.`);
    }
    throwIfAborted(signal);
  }
  if (buffers.size === 0) return null;

  return (async function* () {
    for (let windowStart = 0; windowStart < durationSeconds; windowStart += AUDIO_WINDOW_SECONDS) {
      throwIfAborted(signal);
      const windowEnd = Math.min(durationSeconds, windowStart + AUDIO_WINDOW_SECONDS);
      const frames = Math.max(1, Math.round((windowEnd - windowStart) * SAMPLE_RATE));
      const context = new OfflineAudioContext(CHANNELS, frames, SAMPLE_RATE);
      for (const { clip } of clips) {
        const buffer = buffers.get(clip.assetId);
        if (!buffer) continue;
        const start = clip.startMs / 1000;
        const end = start + clipDuration(clip) / 1000;
        if (end <= windowStart || start >= windowEnd) continue;
        const offset = clip.sourceInMs / 1000 + Math.max(0, windowStart - start);
        if (offset >= buffer.duration) continue;
        const node = context.createBufferSource();
        node.buffer = buffer;
        const gain = context.createGain();
        gain.gain.value = clip.volume ?? 1;
        node.connect(gain).connect(context.destination);
        node.start(Math.max(0, start - windowStart), offset, Math.min(end, windowEnd) - Math.max(start, windowStart));
      }
      const mixed = await context.startRendering();
      const data = new Float32Array(mixed.length * CHANNELS);
      for (let channel = 0; channel < CHANNELS; channel++) data.set(mixed.getChannelData(Math.min(channel, mixed.numberOfChannels - 1)), channel * mixed.length);
      yield new AudioSample({ data, format: 'f32-planar', numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE, timestamp: windowStart });
    }
  })();
}

export async function renderProject(
  job: RenderJob,
  settings: RenderSettings,
  options: { signal?: AbortSignal; onProgress?: (progress: RenderProgress) => void } = {},
): Promise<RenderResult> {
  const { signal, onProgress } = options;
  const warnings: string[] = [];
  const { timeline } = job.project;
  const assetMap = new Map(job.assets.map((asset) => [asset.id, asset]));
  const inputs = new Map<string, Input>();
  const tracks = new Map<string, InputVideoTrack | null>();
  const cursors = new Map<string, FrameCursor<VideoSample>>();
  const images = new Map<string, ImageBitmap>();
  let output: Output | null = null;

  /** Opens a video asset once; null (with a warning) if it can't be decoded. Fails for the recording itself. */
  const videoTrackOf = async (assetId: string): Promise<InputVideoTrack | null> => {
    if (tracks.has(assetId)) return tracks.get(assetId)!;
    const asset = assetMap.get(assetId);
    const blob = job.blobs.get(assetId);
    const essential = assetId === job.recording.screenAssetId;
    const name = asset?.label ?? asset?.kind ?? 'a clip';
    let track: InputVideoTrack | null = null;
    if (blob) {
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
      inputs.set(assetId, input);
      if (!(await input.canRead())) {
        if (essential) throw new RenderError("The recording's file format can't be read for rendering.", 'unsupported-source');
      } else {
        track = await input.getPrimaryVideoTrack();
        if (track && !(await track.canDecode())) {
          if (essential) throw new RenderError(`This browser can't decode the recording's video (${track.codec ?? 'unknown codec'}).`, 'unsupported-source');
          track = null;
        }
      }
    }
    if (!track) {
      if (essential) throw new RenderError('The recording has no video to render.', 'no-video');
      warnings.push(`“${name}” can't be decoded by this browser, so it is left out.`);
    }
    tracks.set(assetId, track);
    return track;
  };

  try {
    const durationSeconds = contentDuration(timeline.tracks) / 1000;
    if (durationSeconds <= 0) throw new RenderError('The timeline is empty: add a clip to render a video.', 'no-video');

    // Check every visual asset up front, so failures surface before any encoding starts.
    for (const track of timeline.tracks) {
      if (track.hidden || (track.kind !== 'video' && track.kind !== 'camera')) continue;
      if (track.kind === 'camera' && !settings.includeCamera) continue;
      for (const clip of track.clips) {
        if (!isMediaClip(clip)) continue;
        const asset = assetMap.get(clip.assetId);
        if (asset?.kind === 'image') {
          if (!images.has(asset.id)) {
            const blob = job.blobs.get(asset.id);
            try {
              if (!blob) throw new Error('missing');
              images.set(asset.id, await createImageBitmap(blob));
            } catch {
              warnings.push(`The image “${asset.label ?? 'image'}” couldn't be read, so it is left out.`);
            }
          }
        } else {
          await videoTrackOf(clip.assetId);
        }
      }
    }

    const source = { width: job.recording.width ?? 1920, height: job.recording.height ?? 1080 };
    const quality = new Quality(settings.quality === 'high' ? 'high' : 'medium');
    const requested = frameSize(source, job.project.aspectRatio, settings.resolution);
    const { size, codec } = await chooseEncoding(requested, settings.frameRate, quality, warnings);
    throwIfAborted(signal);

    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new RenderError('Could not create a drawing surface for rendering.', 'failed');
    const content = contentRect(size, source);

    output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
    const videoSource = new CanvasSource(canvas, { codec, quality, keyFrameInterval: 2 });
    output.addVideoTrack(videoSource, { frameRate: settings.frameRate });
    const audioSamples = await prepareAudioMix(job, durationSeconds, assetMap, warnings, signal);
    const audioSource = audioSamples ? new AudioSampleSource({ codec: 'opus', bitrate: 160_000 }) : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();

    const scene = { ...timelineScene(job.project, job.recording), zoom: true };
    const times = frameTimestamps(durationSeconds, settings.frameRate);

    /** The frame of a media clip at a source time; one cursor per track and asset. */
    const frameOf = async (trackId: string, clip: MediaClip, sourceMs: number): Promise<VideoSample | null> => {
      const track = tracks.get(clip.assetId);
      if (!track) return null;
      const key = `${trackId}:${clip.assetId}`;
      let cursor = cursors.get(key);
      if (!cursor) {
        cursor = new FrameCursor(() => new VideoSampleSink(track).samples());
        cursors.set(key, cursor);
      }
      return cursor.frameAt(sourceMs / 1000);
    };

    const pumpVideo = async () => {
      for (const [index, timestamp] of times.entries()) {
        throwIfAborted(signal);
        const timeMs = timestamp * 1000;
        const visuals = activeVisuals(timeline, timeMs);
        // Decoded frames, in layer order (null where nothing can be shown); images are drawn as they are.
        const layers: Array<VideoSample | ImageBitmap | null> = [];
        let camera: VideoSample | null = null;
        try {
          for (const { track, clip, sourceMs } of visuals.layers) {
            layers.push(images.get(clip.assetId) ?? (await frameOf(track.id, clip, sourceMs)));
          }
          if (visuals.camera && settings.includeCamera) camera = await frameOf(visuals.camera.track.id, visuals.camera.clip, visuals.camera.sourceMs);
          // VideoFrames from `toCanvasImageSource` must be used immediately: converted right here.
          drawFrame(
            ctx,
            size.width,
            size.height,
            {
              layers: layers.map((layer) => (layer instanceof ImageBitmap ? { image: layer, width: layer.width, height: layer.height } : frameImage(layer))),
              camera: frameImage(camera),
              cameraLayout: job.project.cameraLayout,
              texts: visuals.texts,
              content,
            },
            frameStateAt(scene, timeMs),
          );
        } finally {
          for (const layer of layers) if (layer && !(layer instanceof ImageBitmap)) layer.close();
          camera?.close();
        }
        await videoSource.add(timestamp, 1 / settings.frameRate);
        onProgress?.({ frame: index + 1, frames: times.length, fraction: (index + 1) / times.length });
      }
      videoSource.close();
    };

    const pumpAudio = async () => {
      if (!audioSamples || !audioSource) return;
      for await (const sample of audioSamples) {
        try {
          throwIfAborted(signal);
          await audioSource.add(sample);
        } finally {
          sample.close();
        }
      }
      audioSource.close();
    };

    await Promise.all([pumpVideo(), pumpAudio()]);
    throwIfAborted(signal);
    await output.finalize();
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new RenderError('The rendered video is empty.', 'failed');
    return {
      blob: new Blob([buffer], { type: await output.getMimeType() }),
      fileName: `${safeFileName(job.recording.name)} (edited).webm`,
      width: size.width,
      height: size.height,
      frameRate: settings.frameRate,
      frames: times.length,
      durationSeconds,
      videoCodec: codec,
      audio: audioSource ? 'mixed' : 'none',
      warnings,
    };
  } catch (error) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => undefined);
    throw error;
  } finally {
    for (const cursor of cursors.values()) await cursor.close().catch(() => undefined);
    for (const input of inputs.values()) input.dispose();
    for (const image of images.values()) image.close();
  }
}
