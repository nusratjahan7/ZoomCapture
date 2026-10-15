import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type InputVideoTrack, type VideoSample } from 'mediabunny';
import { isMediaClip, isStill } from '@/services/timeline/model';
import type { Size } from '@/services/zoom/coordinates';
import type { MediaAsset, MediaClip, Project, Recording } from '@/types';
import { activeVisuals, timelineScene, type Rect } from './compose';
import { drawFrame, type FrameImage } from './draw';
import { activeCues, backgroundOf, frameLayoutOf, layoutRect, subtitleStyleOf } from './enhancements';
import { frameStateAt } from './frameState';
import { StillCache, type StillSource } from './stills';

/**
 * Draws the edited timeline at any time into an offscreen canvas, at the output size: every
 * visible video, image and PDF page in track order, the camera bubble, text, callouts and
 * watermarks, subtitles, the background and layout, and the zoom effects. It calls the same
 * `drawFrame` as the editor preview, so every export format (video, GIF, still) shows exactly
 * what the preview shows.
 *
 * Source frames are decoded with WebCodecs (via Mediabunny) and released right after drawing;
 * images and PDF pages are decoded at the size needed, a few at a time.
 */

export interface RenderJob {
  recording: Recording;
  project: Project;
  assets: readonly MediaAsset[];
  /** Stored bytes of every asset used on the timeline (and the background image). */
  blobs: ReadonlyMap<string, Blob>;
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

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Rendering was cancelled.', 'AbortError');
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
  /** Operations run one at a time: a `close()` during a decode waits for it, so no frame decoded after closing is left unclosed. */
  private queue: Promise<unknown> = Promise.resolve();
  restarts = 0;

  constructor(private readonly open: () => AsyncIterator<T>) {}

  frameAt(seconds: number): Promise<T | null> {
    return this.serial(() => this.advance(seconds));
  }

  close(): Promise<void> {
    return this.serial(() => this.release());
  }

  private serial<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async advance(seconds: number): Promise<T | null> {
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

  private async release(): Promise<void> {
    this.current?.close();
    this.current = null;
    if (this.next && !this.next.done) this.next.value.close();
    this.next = null;
    const iterator = this.iterator;
    this.iterator = null;
    await iterator?.return?.(undefined);
  }

  private async restart() {
    if (this.iterator) this.restarts += 1;
    await this.release();
    this.iterator = this.open();
    this.next = await this.iterator.next();
  }
}

const frameImage = (sample: VideoSample | null | undefined): FrameImage | null =>
  sample ? { image: sample.toCanvasImageSource(), width: sample.displayWidth, height: sample.displayHeight } : null;

export interface FrameRenderer {
  /** Checked before any output is made: unreadable media is reported here (or throws for the recording). */
  readonly warnings: string[];
  /** The recording's own size (the shape the layout is computed from). */
  readonly source: Size;
  /** Creates the drawing surface; call once the output size is known. */
  start(size: Size, options?: { readback?: boolean }): Promise<OffscreenCanvas>;
  /** Draws the timeline at `timeMs` into the canvas. */
  render(timeMs: number): Promise<void>;
  /** The 2D context (for reading pixels back, e.g. the GIF encoder). */
  readonly context: OffscreenCanvasRenderingContext2D;
  /** Releases decoders, decoded frames, images and the canvas. */
  close(): Promise<void>;
}

/**
 * Opens and checks every visual source of the job (failures surface before any encoding), then
 * returns a renderer to draw frames with.
 */
export async function createFrameRenderer(job: RenderJob, options: { includeCamera: boolean; signal?: AbortSignal; warnings?: string[] }): Promise<FrameRenderer> {
  const { includeCamera, signal } = options;
  const warnings = options.warnings ?? [];
  const { project } = job;
  const { timeline } = project;
  const assetMap = new Map(job.assets.map((asset) => [asset.id, asset]));
  const inputs = new Map<string, Input>();
  const tracks = new Map<string, InputVideoTrack | null>();
  const cursors = new Map<string, FrameCursor<VideoSample>>();
  const stills = new StillCache(8);
  const source = { width: job.recording.width ?? 1920, height: job.recording.height ?? 1080 };
  let canvas: OffscreenCanvas | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  let size: Size = source;
  let content: Rect = { x: 0, y: 0, ...source };
  let backgroundImage: ImageBitmap | null = null;
  let closed = false;
  /** The frame being drawn: `close()` waits for it, so nothing is decoded or cached after closing. */
  let drawing: Promise<void> | null = null;

  const stillSource = (clip: MediaClip): StillSource | null => {
    const asset = assetMap.get(clip.assetId);
    const blob = job.blobs.get(clip.assetId);
    if (!asset || !blob || !isStill(asset)) return null;
    return {
      assetId: asset.id,
      kind: asset.kind === 'pdf' ? 'pdf' : 'image',
      page: clip.page,
      size: asset.width && asset.height ? { width: asset.width, height: asset.height } : undefined,
      load: async () => blob,
    };
  };

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

  const close = async () => {
    if (closed) return;
    closed = true;
    await drawing?.catch(() => undefined);
    for (const cursor of cursors.values()) await cursor.close().catch(() => undefined);
    cursors.clear();
    for (const input of inputs.values()) input.dispose();
    inputs.clear();
    stills.clear();
    backgroundImage = null;
    // Releases the canvas's backing store now rather than at garbage collection.
    if (canvas) canvas.width = canvas.height = 0;
    canvas = null;
    ctx = null;
  };

  try {
    // Check every visual asset up front, so failures surface before any encoding starts.
    const checkedStills = new Set<string>();
    for (const track of timeline.tracks) {
      if (track.hidden || (track.kind !== 'video' && track.kind !== 'camera')) continue;
      if (track.kind === 'camera' && !includeCamera) continue;
      for (const clip of track.clips) {
        if (!isMediaClip(clip)) continue;
        throwIfAborted(signal);
        const asset = assetMap.get(clip.assetId);
        if (asset && isStill(asset)) {
          // Each file is checked once (its first page used); pages are drawn later, as needed.
          if (checkedStills.has(asset.id)) continue;
          checkedStills.add(asset.id);
          const still = stillSource(clip);
          const bitmap = still ? await stills.get(still, { width: 256, height: 256 }) : null;
          if (!bitmap) warnings.push(`${asset.kind === 'pdf' ? 'The PDF' : 'The image'} “${asset.label ?? asset.kind}” couldn't be read, so it is left out.`);
        } else {
          await videoTrackOf(clip.assetId);
        }
      }
    }
  } catch (error) {
    await close();
    throw error;
  }

  const background = backgroundOf(project);
  const frameLayout = frameLayoutOf(project);
  const subtitleStyle = subtitleStyleOf(project);
  const scene = { ...timelineScene(project, job.recording), zoom: true };

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

  return {
    warnings,
    source,
    get context() {
      if (!ctx) throw new RenderError('The renderer is not started.', 'failed');
      return ctx;
    },
    async start(outputSize, startOptions = {}) {
      size = outputSize;
      canvas = new OffscreenCanvas(size.width, size.height);
      ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: Boolean(startOptions.readback) });
      if (!ctx) throw new RenderError('Could not create a drawing surface for rendering (the device may be out of memory).', 'failed');
      content = layoutRect(size, source, frameLayout);
      // An imported background image, decoded once at the output size.
      if (background.kind === 'image' && background.imageAssetId) {
        const blob = job.blobs.get(background.imageAssetId);
        const asset = assetMap.get(background.imageAssetId);
        backgroundImage = blob
          ? await stills.get(
              { assetId: background.imageAssetId, kind: 'image', size: asset?.width && asset.height ? { width: asset.width, height: asset.height } : undefined, load: async () => blob },
              size,
            )
          : null;
        if (!backgroundImage) warnings.push("The background image couldn't be read, so its colour is used instead.");
      }
      return canvas;
    },
    render(timeMs) {
      if (closed) return Promise.reject(new RenderError('The renderer is closed.', 'failed'));
      drawing = draw(timeMs);
      return drawing;
    },
    close,
  };

  async function draw(timeMs: number): Promise<void> {
    if (!ctx) throw new RenderError('The renderer is not started.', 'failed');
    const visuals = activeVisuals(timeline, timeMs);
    // Decoded frames, in layer order (null where nothing can be shown); images are drawn as they are.
    const layers: Array<VideoSample | ImageBitmap | null> = [];
    let camera: VideoSample | null = null;
    try {
      for (const { track, clip, sourceMs } of visuals.layers) {
        const still = stillSource(clip);
        layers.push(still ? await stills.get(still, content) : await frameOf(track.id, clip, sourceMs));
      }
      if (visuals.camera && includeCamera) camera = await frameOf(visuals.camera.track.id, visuals.camera.clip, visuals.camera.sourceMs);
      // VideoFrames from `toCanvasImageSource` must be used immediately: converted right here.
      drawFrame(
        ctx,
        size.width,
        size.height,
        {
          layers: layers.map((layer, index) => {
            const image = layer instanceof ImageBitmap ? { image: layer, width: layer.width, height: layer.height } : frameImage(layer);
            const { clip } = visuals.layers[index]!;
            return image && { ...image, transform: clip.transform, opacity: clip.opacity };
          }),
          camera: frameImage(camera),
          cameraLayout: project.cameraLayout,
          texts: visuals.texts,
          content,
          background: { style: background, image: backgroundImage && { image: backgroundImage, width: backgroundImage.width, height: backgroundImage.height } },
          frameLayout,
          subtitles: { lines: activeCues(project, timeMs).map((cue) => cue.text), style: subtitleStyle },
        },
        frameStateAt(scene, timeMs),
      );
    } finally {
      for (const layer of layers) if (layer && !(layer instanceof ImageBitmap)) layer.close();
      camera?.close();
    }
  }
}
