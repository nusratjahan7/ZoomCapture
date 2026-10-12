import { markerSpan } from '@/services/zoom/markers';
import type { CursorSample, InteractionEvent, NormalizedPoint, RenderEffects, ZoomMarker } from '@/types';
import { cameraFor, clampCamera, IDENTITY_CAMERA, lerpCamera, toOutput, type Camera } from './camera';
import { cursorAt, followPath, smoothPathAt, type PathPoint } from './paths';

/**
 * Everything the renderer draws at one moment, computed from marker data and the media time only.
 * The editor preview and the rendered video both call `frameStateAt`, so they show the same zoom
 * at the same timestamp by construction.
 */

/** Time constant of the follow-cursor camera (higher = smoother, slower to catch up). */
export const FOLLOW_SMOOTHING_MS = 300;
/** How long a click's emphasis ring lasts. */
export const CLICK_EMPHASIS_MS = 650;

export function defaultRenderEffects(): RenderEffects {
  return { cursorHighlight: false, clickEmphasis: true };
}

export function renderEffectsOf(project: { renderEffects?: RenderEffects }): RenderEffects {
  return { ...defaultRenderEffects(), ...project.renderEffects };
}

export interface RenderScene {
  /** Sorted by time (as stored). Disabled markers are ignored. */
  markers: readonly ZoomMarker[];
  /** Tracked clicks, sorted by time. */
  clicks: readonly InteractionEvent[];
  /** Tracked pointer samples, sorted by time (may be empty). */
  cursor: readonly CursorSample[];
  effects: RenderEffects;
  /** False shows the frame without zoom effects (preview toggle). Overlays are still drawn. */
  zoom: boolean;
}

/** Positions below are in output coordinates (normalised 0-1, after the camera). */
export interface FrameState {
  timeMs: number;
  camera: Camera;
  /** The most recently started active effect. */
  activeMarkerId: string | null;
  highlight: { point: NormalizedPoint; strength: number } | null;
  annotation: { text: string; opacity: number } | null;
  /** `progress` 0 → 1 over the ring's life. */
  ripples: Array<{ point: NormalizedPoint; progress: number }>;
  cursor: NormalizedPoint | null;
}

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** 0 → 1 while easing in, 1 while holding, 1 → 0 while easing out, 0 outside the span. */
export function markerStrength(marker: Pick<ZoomMarker, 'timeMs' | 'durationMs' | 'transitionMs'>, timeMs: number): number {
  const { startMs, endMs } = markerSpan(marker);
  if (timeMs <= startMs || timeMs >= endMs) return 0;
  const holdEnd = marker.timeMs + marker.durationMs;
  if (timeMs < marker.timeMs) return easeInOutCubic((timeMs - startMs) / marker.transitionMs);
  if (timeMs <= holdEnd) return 1;
  return 1 - easeInOutCubic((timeMs - holdEnd) / marker.transitionMs);
}

const followPointsCache = new WeakMap<object, PathPoint[]>();

/**
 * Visible pointer samples, or the clicks for recordings without pointer movement. Cached per
 * input array, so drawing a frame does not re-scan thousands of samples.
 */
export function followPoints(scene: Pick<RenderScene, 'clicks' | 'cursor'>): PathPoint[] {
  const key = scene.cursor.length > 0 ? scene.cursor : scene.clicks;
  let points = followPointsCache.get(key);
  if (!points) {
    const visible = scene.cursor.filter((sample) => !sample.hidden);
    points =
      visible.length > 0 ? visible : scene.clicks.map((click) => ({ timeMs: click.timeMs, x: click.position.x, y: click.position.y }));
    followPointsCache.set(key, points);
  }
  return points;
}

/** Where an effect points at `timeMs` (source coordinates). */
export function markerFocusAt(marker: ZoomMarker, timeMs: number, points: readonly PathPoint[]): NormalizedPoint {
  if (marker.positionMode !== 'follow-cursor' || timeMs <= marker.timeMs || points.length === 0) return marker.position;
  return smoothPathAt(followPath(marker.position, marker.timeMs, points, timeMs, FOLLOW_SMOOTHING_MS), timeMs, FOLLOW_SMOOTHING_MS);
}

/** Active effects at `timeMs` with their strength, oldest first. */
export function activeMarkers(markers: readonly ZoomMarker[], timeMs: number): Array<{ marker: ZoomMarker; strength: number }> {
  const active: Array<{ marker: ZoomMarker; strength: number }> = [];
  for (const marker of markers) {
    if (!marker.enabled) continue;
    const strength = markerStrength(marker, timeMs);
    if (strength > 0) active.push({ marker, strength });
  }
  return active.sort((a, b) => a.marker.timeMs - b.marker.timeMs || a.marker.createdAt - b.marker.createdAt);
}

/**
 * The camera at `timeMs`. Effects are applied oldest first, each blending from the camera so far
 * towards its own framing by its strength. A single effect zooms from the full frame and back;
 * an effect starting while another holds pans and zooms from that framing to its own and, when
 * it ends, back again. No jumps when effects overlap or nest.
 */
export function cameraAt(scene: Pick<RenderScene, 'markers' | 'clicks' | 'cursor' | 'zoom'>, timeMs: number, points = followPoints(scene)): Camera {
  if (!scene.zoom) return IDENTITY_CAMERA;
  let camera = IDENTITY_CAMERA;
  for (const { marker, strength } of activeMarkers(scene.markers, timeMs)) {
    if (marker.effect !== 'zoom') continue;
    camera = lerpCamera(camera, cameraFor(markerFocusAt(marker, timeMs, points), marker.scale), strength);
  }
  return clampCamera(camera);
}

export function frameStateAt(scene: RenderScene, timeMs: number): FrameState {
  const points = followPoints(scene);
  const camera = cameraAt(scene, timeMs, points);
  const active = activeMarkers(scene.markers, timeMs);
  const latest = active.at(-1);

  let highlight: FrameState['highlight'] = null;
  let annotation: FrameState['annotation'] = null;
  for (const { marker, strength } of active) {
    if (marker.effect === 'highlight') highlight = { point: toOutput(markerFocusAt(marker, timeMs, points), camera), strength };
    if (marker.annotation) annotation = { text: marker.annotation, opacity: strength };
  }

  const ripples: FrameState['ripples'] = [];
  if (scene.effects.clickEmphasis) {
    for (const click of scene.clicks) {
      if (click.timeMs > timeMs) break;
      const age = timeMs - click.timeMs;
      if (age < CLICK_EMPHASIS_MS) ripples.push({ point: toOutput(click.position, camera), progress: age / CLICK_EMPHASIS_MS });
    }
  }

  const pointer = scene.effects.cursorHighlight ? cursorAt(scene.cursor, timeMs) : null;
  return {
    timeMs,
    camera,
    activeMarkerId: latest?.marker.id ?? null,
    highlight,
    annotation,
    ripples,
    cursor: pointer && toOutput(pointer, camera),
  };
}
