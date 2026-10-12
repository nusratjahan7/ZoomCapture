import type { CameraLayout } from '@/types';
import { drawFrame } from './draw';
import { frameStateAt, type FrameState, type RenderScene } from './frameState';

export interface PreviewSources {
  video: HTMLVideoElement;
  /** Muted follower element for the camera bubble (kept in sync elsewhere). */
  camera?: HTMLVideoElement | null;
  cameraLayout?: CameraLayout;
}

/**
 * Draws the editor preview onto a canvas with the same `drawFrame(frameStateAt(…))` used for the
 * rendered video.
 *
 * Timing comes from the media element (`video.currentTime`), never from wall-clock timers, so
 * pausing, seeking, scrubbing and playback-rate changes are followed automatically. While playing,
 * a requestAnimationFrame loop draws each display frame (zoom animates even when the recording
 * holds a still frame); while paused, nothing runs and a frame is drawn only when something
 * changes (seek, new decoded frame, edited markers, resize). A frame is skipped when neither the
 * media time nor the scene changed.
 */
export class PreviewRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private sources: PreviewSources | null = null;
  private scene: RenderScene | null = null;
  private frame = 0;
  private videoFrameRequest = 0;
  private dirty = true;
  private lastTime = Number.NaN;
  private lastState: FrameState | null = null;
  private readonly detach: Array<() => void> = [];
  private readonly resizeObserver: ResizeObserver;
  /** Number of frames actually drawn (exposed for tests and diagnostics). */
  drawCount = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onFrame?: (state: FrameState) => void,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available.');
    this.ctx = ctx;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
  }

  setSources(sources: PreviewSources): void {
    this.detachSources();
    this.sources = sources;
    const { video } = sources;
    const invalidate = () => this.invalidate();
    const onPlay = () => this.startLoop();
    const events = ['seeked', 'seeking', 'loadeddata', 'pause', 'ended', 'ratechange', 'resize', 'emptied'] as const;
    events.forEach((name) => video.addEventListener(name, invalidate));
    video.addEventListener('play', onPlay);
    video.addEventListener('playing', onPlay);
    sources.camera?.addEventListener('seeked', invalidate);
    sources.camera?.addEventListener('loadeddata', invalidate);
    this.detach.push(() => {
      events.forEach((name) => video.removeEventListener(name, invalidate));
      video.removeEventListener('play', onPlay);
      video.removeEventListener('playing', onPlay);
      sources.camera?.removeEventListener('seeked', invalidate);
      sources.camera?.removeEventListener('loadeddata', invalidate);
    });
    this.watchVideoFrames();
    this.resize();
    if (!video.paused) this.startLoop();
  }

  setScene(scene: RenderScene): void {
    this.scene = scene;
    this.invalidate();
  }

  /** The state of the frame on screen. */
  get state(): FrameState | null {
    return this.lastState;
  }

  /** Draws on the next animation frame (once, however often it is called). */
  invalidate(): void {
    this.dirty = true;
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.detachSources();
    this.resizeObserver.disconnect();
    this.sources = null;
    this.scene = null;
  }

  private detachSources() {
    this.detach.splice(0).forEach((undo) => undo());
    if (this.videoFrameRequest && this.sources) this.sources.video.cancelVideoFrameCallback(this.videoFrameRequest);
    this.videoFrameRequest = 0;
  }

  /** Redraw when a new frame is decoded while paused (e.g. the frame after a seek arrives late). */
  private watchVideoFrames() {
    const video = this.sources?.video;
    if (!video || !('requestVideoFrameCallback' in video)) return;
    const onVideoFrame = () => {
      if (this.sources?.video !== video) return;
      this.invalidate();
      this.videoFrameRequest = video.requestVideoFrameCallback(onVideoFrame);
    };
    this.videoFrameRequest = video.requestVideoFrameCallback(onVideoFrame);
  }

  private startLoop() {
    this.invalidate();
  }

  private resize() {
    const video = this.sources?.video;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    // Never more pixels than the recording has: a larger canvas only costs time.
    const maxWidth = video?.videoWidth || Number.POSITIVE_INFINITY;
    const width = Math.max(2, Math.round(Math.min(rect.width * ratio, maxWidth)));
    const height = Math.max(2, Math.round((width * rect.height) / rect.width));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.dirty = true;
    }
    this.invalidate();
  }

  private readonly tick = () => {
    this.frame = 0;
    const video = this.sources?.video;
    if (!video || !this.scene) return;
    const timeMs = video.currentTime * 1000;
    if (this.dirty || timeMs !== this.lastTime) this.draw(video, timeMs);
    // Keep animating only while the media clock is running.
    if (!video.paused && !video.ended) this.frame = requestAnimationFrame(this.tick);
  };

  private draw(video: HTMLVideoElement, timeMs: number) {
    if (!this.scene) return;
    const camera = this.sources?.camera;
    const state = frameStateAt(this.scene, timeMs);
    const hasFrame = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0;
    const cameraReady = camera && camera.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && camera.videoWidth > 0;
    drawFrame(
      this.ctx,
      this.canvas.width,
      this.canvas.height,
      {
        screen: hasFrame ? { image: video, width: video.videoWidth, height: video.videoHeight } : null,
        camera: cameraReady ? { image: camera, width: camera.videoWidth, height: camera.videoHeight } : null,
        cameraLayout: this.sources?.cameraLayout,
      },
      state,
    );
    this.drawCount += 1;
    this.dirty = false;
    this.lastTime = timeMs;
    this.lastState = state;
    this.onFrame?.(state);
  }
}
