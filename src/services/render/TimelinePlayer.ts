import { clipAt, contentDuration, isStill } from '@/services/timeline/model';
import type { Size } from '@/services/zoom/coordinates';
import type { BackgroundStyle, CameraLayout, FrameLayout, MediaAssetKind, MediaClip, SubtitleStyle, SubtitleTrack, Timeline, TimelineTrack } from '@/types';
import { activeVisuals } from './compose';
import { activeCues, layoutRect } from './enhancements';
import { drawFrame, type FrameImage } from './draw';
import { frameStateAt, type FrameState, type RenderScene } from './frameState';
import { StillCache } from './stills';
import { clipGain } from './audioMix';

/** What the player shows; replaced as a whole whenever the project changes. */
export interface PlayerContent {
  timeline: Timeline;
  scene: Omit<RenderScene, 'zoom'>;
  zoom: boolean;
  cameraLayout?: CameraLayout;
  /** Size of the recording's picture (sets the content area). */
  source: Size;
  /** Width / height of the output frame. */
  aspect: number;
  /** Playable URL and kind of every asset on the timeline (and the size of images). */
  assets: ReadonlyMap<string, { url: string; kind: MediaAssetKind; width?: number; height?: number }>;
  /** Module 08: background, the recording's layout on it, and subtitles. */
  enhancements?: {
    background: BackgroundStyle;
    frameLayout: FrameLayout;
    subtitleStyle: SubtitleStyle;
    subtitles: readonly SubtitleTrack[];
  };
}

interface TrackSlot {
  element: HTMLMediaElement;
  assetId: string | null;
}

/** While playing, media drifting further than this from the playhead is re-seeked. */
const DRIFT_SECONDS = 0.25;
/** How far ahead an upcoming clip is loaded and positioned, so cuts play without a gap. */
const PRELOAD_MS = 1500;

/**
 * Plays an edited timeline in the editor preview.
 *
 * One playhead clock drives everything. Each track gets one media element, which is pointed at
 * the asset of the clip under the playhead and seeked to that clip's source time. While playing,
 * the playhead follows the bottom video layer's media time whenever it is playing smoothly (so
 * zoom stays locked to the picture), and a wall clock otherwise (gaps, images, buffering).
 * Frames are drawn with the same `drawFrame(frameStateAt(…))` the rendered video uses.
 *
 * Playback updates go to `onTime` listeners, not to React state: the UI updates the playhead and
 * timecode directly, so the editor does not re-render on every frame. While paused nothing runs;
 * a frame is drawn only after a seek, an edit, a resize or a newly decoded frame.
 */
export class TimelinePlayer {
  private readonly ctx: CanvasRenderingContext2D;
  private content: PlayerContent | null = null;
  private readonly slots = new Map<string, TrackSlot>();
  /** Images and PDF pages, decoded at preview size (a newly decoded one redraws the frame). */
  private readonly stills = new StillCache(16, () => this.invalidate());
  private anchorTime = 0;
  private anchorNow = 0;
  private rate = 1;
  private allMuted = false;
  private isPlaying = false;
  private frame = 0;
  private dirty = true;
  private lastDrawn = Number.NaN;
  private readonly timeListeners = new Set<(timeMs: number, playing: boolean) => void>();
  private readonly resizeObserver: ResizeObserver;
  lastState: FrameState | null = null;
  /** Frames actually drawn (diagnostics and tests). */
  drawCount = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly onFrame?: (state: FrameState) => void,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available.');
    this.ctx = ctx;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
  }

  get time(): number {
    return this.isPlaying ? Math.min(this.duration, this.anchorTime + (performance.now() - this.anchorNow) * this.rate) : this.anchorTime;
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  get duration(): number {
    return this.content ? contentDuration(this.content.timeline.tracks) : 0;
  }

  get playbackRate(): number {
    return this.rate;
  }

  setContent(content: PlayerContent): void {
    this.content = content;
    // Elements of tracks that no longer exist are released.
    for (const [trackId, slot] of this.slots) {
      if (!content.timeline.tracks.some((track) => track.id === trackId)) this.releaseSlot(trackId, slot);
    }
    if (this.anchorTime > this.duration) this.anchorTime = this.duration;
    this.syncMedia(this.time);
    this.resize();
    this.invalidate();
  }

  onTime(listener: (timeMs: number, playing: boolean) => void): () => void {
    this.timeListeners.add(listener);
    listener(this.time, this.isPlaying);
    return () => this.timeListeners.delete(listener);
  }

  play(): void {
    if (this.isPlaying || !this.content || this.duration <= 0) return;
    if (this.anchorTime >= this.duration - 1) this.anchorTime = 0;
    this.isPlaying = true;
    this.anchorNow = performance.now();
    this.syncMedia(this.anchorTime);
    this.emit(this.anchorTime);
    this.invalidate();
  }

  pause(): void {
    if (!this.isPlaying) return;
    this.anchorTime = this.time;
    this.isPlaying = false;
    this.syncMedia(this.anchorTime);
    this.emit(this.anchorTime);
    this.invalidate();
  }

  toggle(): void {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  /** Moves the playhead (clamped to the timeline). Keeps playing if playing. */
  seek(timeMs: number): void {
    this.anchorTime = Math.min(Math.max(0, timeMs), this.duration);
    this.anchorNow = performance.now();
    this.syncMedia(this.anchorTime);
    this.emit(this.anchorTime);
    this.invalidate();
  }

  /** Silences all playback (e.g. while a voiceover is recorded, so the microphone doesn't pick it up). */
  setMuted(muted: boolean): void {
    this.allMuted = muted;
    for (const slot of this.slots.values()) if (muted) slot.element.muted = true;
    this.invalidate();
  }

  setRate(rate: number): void {
    this.anchorTime = this.time;
    this.anchorNow = performance.now();
    this.rate = rate;
    for (const slot of this.slots.values()) slot.element.playbackRate = rate;
  }

  /** Draws on the next animation frame (once, however often it is called). */
  invalidate(): void {
    this.dirty = true;
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.isPlaying = false;
    this.resizeObserver.disconnect();
    for (const [trackId, slot] of this.slots) this.releaseSlot(trackId, slot);
    this.stills.clear();
    this.timeListeners.clear();
    this.content = null;
  }

  private emit(timeMs: number) {
    for (const listener of this.timeListeners) listener(timeMs, this.isPlaying);
  }

  private readonly tick = () => {
    this.frame = 0;
    if (!this.content) return;
    let time = this.time;
    if (this.isPlaying) {
      const lead = this.leadTime(time);
      if (lead !== null && Math.abs(lead - time) < DRIFT_SECONDS * 1000) {
        time = Math.min(lead, this.duration);
        this.anchorTime = time;
        this.anchorNow = performance.now();
      }
      if (time >= this.duration) {
        this.anchorTime = this.duration;
        this.isPlaying = false;
        time = this.duration;
      }
      this.syncMedia(time);
      this.emit(time);
    }
    if (this.dirty || time !== this.lastDrawn) this.draw(time);
    if (this.isPlaying) this.frame = requestAnimationFrame(this.tick);
  };

  /** Playhead position implied by the bottom video layer, when its media is playing smoothly. */
  private leadTime(time: number): number | null {
    const tracks = this.content!.timeline.tracks;
    for (let index = tracks.length - 1; index >= 0; index--) {
      const track = tracks[index]!;
      if (track.kind !== 'video' || track.hidden) continue;
      const clip = clipAt(track, time);
      if (!clip || clip.type !== 'media') continue;
      const slot = this.slots.get(track.id);
      const element = slot?.element;
      if (!element || slot.assetId !== clip.assetId || element.paused || element.seeking || element.readyState < 3) return null;
      return clip.startMs + element.currentTime * 1000 - clip.sourceInMs;
    }
    return null;
  }

  /** Points every track's element at the clip under `time` and keeps it in step. */
  private syncMedia(time: number) {
    if (!this.content) return;
    for (const track of this.content.timeline.tracks) {
      if (track.kind === 'text') continue;
      const clip = clipAt(track, time);
      if (clip && clip.type === 'media') {
        this.syncClip(track, clip, time);
        continue;
      }
      // No clip here: pause, and get the next clip ready if it starts soon.
      const slot = this.slots.get(track.id);
      slot?.element.pause();
      const next = track.clips.find((candidate) => candidate.startMs > time && candidate.startMs - time < PRELOAD_MS);
      if (next?.type === 'media' && this.isPlaying) this.prepare(track, next, next.startMs, false);
    }
  }

  private syncClip(track: TimelineTrack, clip: MediaClip, time: number) {
    const element = this.prepare(track, clip, time, true);
    if (!element) return;
    if (this.isPlaying) {
      if (element.paused) void element.play().catch(() => undefined);
    } else if (!element.paused) {
      element.pause();
    }
  }

  /** Loads the clip's asset into the track's element and seeks it; returns the element (null for stills). */
  private prepare(track: TimelineTrack, clip: MediaClip, time: number, current: boolean): HTMLMediaElement | null {
    const asset = this.content!.assets.get(clip.assetId);
    if (!asset) return null;
    if (isStill(asset)) {
      // The track's media element (if it played a video before) must fall silent. Other tracks
      // (voiceover, music) keep playing while the image or page is shown.
      if (current) this.slots.get(track.id)?.element.pause();
      return null;
    }
    const slot = this.slot(track);
    const element = slot.element;
    if (slot.assetId !== clip.assetId) {
      slot.assetId = clip.assetId;
      element.src = asset.url;
    }
    const expected = (clip.sourceInMs + (time - clip.startMs)) / 1000;
    const tolerance = this.isPlaying && current ? DRIFT_SECONDS : 0.0005;
    // While playing, a seek in progress is left to finish; while paused the frame must be exact,
    // so a newer position replaces a pending seek.
    if ((!element.seeking || !this.isPlaying) && Math.abs(element.currentTime - expected) > tolerance) element.currentTime = expected;
    element.playbackRate = this.rate;
    const silent = this.allMuted || track.kind === 'camera' || track.muted || clip.muted;
    element.muted = Boolean(silent);
    // Clip and track volume and fades, updated every frame while playing (see audioMix.ts).
    element.volume = clipGain({ ...clip, muted: false }, { volume: track.volume }, time);
    return element;
  }

  private slot(track: TimelineTrack): TrackSlot {
    let slot = this.slots.get(track.id);
    if (!slot) {
      const element = document.createElement(track.kind === 'audio' || track.kind === 'music' ? 'audio' : 'video');
      element.preload = 'auto';
      element.dataset.track = track.id;
      if (element instanceof HTMLVideoElement) {
        element.playsInline = true;
        element.className = 'absolute inset-0 h-full w-full';
      }
      const invalidate = () => this.invalidate();
      element.addEventListener('seeked', invalidate);
      element.addEventListener('loadeddata', invalidate);
      element.addEventListener('canplay', invalidate);
      this.host.append(element);
      slot = { element, assetId: null };
      this.slots.set(track.id, slot);
    }
    return slot;
  }

  private releaseSlot(trackId: string, slot: TrackSlot) {
    slot.element.pause();
    slot.element.removeAttribute('src');
    slot.element.load();
    slot.element.remove();
    this.slots.delete(trackId);
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || !this.content) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    // Never more pixels than the recording has across: a larger canvas only costs time.
    const width = Math.max(2, Math.round(Math.min(rect.width * ratio, Math.max(this.content.source.width, this.content.source.height))));
    const height = Math.max(2, Math.round(width / this.content.aspect));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.invalidate();
  }

  /** An imported background image, decoded at the canvas size (null until ready, or without one). */
  private backgroundImage(width: number, height: number): FrameImage | null {
    const background = this.content?.enhancements?.background;
    if (background?.kind !== 'image' || !background.imageAssetId) return null;
    const asset = this.content!.assets.get(background.imageAssetId);
    if (!asset) return null;
    const bitmap = this.stills.peek(
      {
        assetId: background.imageAssetId,
        kind: 'image',
        size: asset.width && asset.height ? { width: asset.width, height: asset.height } : undefined,
        load: () => fetch(asset.url).then((response) => response.blob()),
      },
      { width, height },
    );
    return bitmap ? { image: bitmap, width: bitmap.width, height: bitmap.height } : null;
  }

  private frameImageFor(track: TimelineTrack, clip: MediaClip): FrameImage | null {
    const asset = this.content!.assets.get(clip.assetId);
    if (!asset) return null;
    if (isStill(asset)) {
      const content = layoutRect({ width: this.canvas.width, height: this.canvas.height }, this.content!.source, this.content!.enhancements?.frameLayout);
      const bitmap = this.stills.peek(
        {
          assetId: clip.assetId,
          kind: asset.kind === 'pdf' ? 'pdf' : 'image',
          page: clip.page,
          size: asset.width && asset.height ? { width: asset.width, height: asset.height } : undefined,
          load: () => fetch(asset.url).then((response) => response.blob()),
        },
        content,
      );
      return bitmap ? { image: bitmap, width: bitmap.width, height: bitmap.height, transform: clip.transform, opacity: clip.opacity } : null;
    }
    const slot = this.slots.get(track.id);
    const element = slot?.element;
    if (!(element instanceof HTMLVideoElement) || slot!.assetId !== clip.assetId) return null;
    if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || element.videoWidth === 0) return null;
    return {
      image: element,
      width: element.videoWidth,
      height: element.videoHeight,
      transform: track.kind === 'video' ? clip.transform : undefined,
      opacity: track.kind === 'video' ? clip.opacity : undefined,
    };
  }

  private draw(time: number) {
    const content = this.content!;
    const { width, height } = this.canvas;
    const visuals = activeVisuals(content.timeline, time);
    const state = frameStateAt({ ...content.scene, zoom: content.zoom }, time);
    drawFrame(
      this.ctx,
      width,
      height,
      {
        layers: visuals.layers.map(({ track, clip }) => this.frameImageFor(track, clip)),
        camera: visuals.camera ? this.frameImageFor(visuals.camera.track, visuals.camera.clip) : null,
        cameraLayout: content.cameraLayout,
        texts: visuals.texts,
        content: layoutRect({ width, height }, content.source, content.enhancements?.frameLayout),
        background: content.enhancements ? { style: content.enhancements.background, image: this.backgroundImage(width, height) } : undefined,
        frameLayout: content.enhancements?.frameLayout,
        subtitles: content.enhancements
          ? { lines: activeCues({ subtitles: [...content.enhancements.subtitles] }, time).map((cue) => cue.text), style: content.enhancements.subtitleStyle }
          : undefined,
      },
      state,
    );
    this.drawCount += 1;
    this.dirty = false;
    this.lastDrawn = time;
    this.lastState = state;
    this.onFrame?.(state);
  }
}
