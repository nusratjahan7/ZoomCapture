import { ZOOM_LIMITS, type InteractionEvent, type NormalizedPoint, type ZoomMarker, type ZoomSettings } from '@/types';
import { createId } from '@/utils/id';
import { dedupeInteractions } from './clicks';
import { clampFocus } from './coordinates';

/**
 * Zoom marker logic: generation from clicks, editing operations and evaluation at a point in time.
 * Everything here is pure (no storage, no DOM) so it is shared by the studio, editor and tests.
 *
 * Timing of one marker:
 *   [timeMs − transitionMs, timeMs]                     zooming in
 *   [timeMs, timeMs + durationMs]                        holding
 *   [timeMs + durationMs, … + transitionMs]              zooming out
 */

export type MarkerDefaults = Pick<ZoomSettings, 'defaultScale' | 'durationMs' | 'transitionMs'>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function markerSpan(marker: Pick<ZoomMarker, 'timeMs' | 'durationMs' | 'transitionMs'>): { startMs: number; endMs: number } {
  return { startMs: marker.timeMs - marker.transitionMs, endMs: marker.timeMs + marker.durationMs + marker.transitionMs };
}

export function sortMarkers(markers: ZoomMarker[]): ZoomMarker[] {
  return [...markers].sort((a, b) => a.timeMs - b.timeMs || a.createdAt - b.createdAt);
}

/** Clamps every field into its valid range; used for every create and edit. */
export function normalizeMarker(marker: ZoomMarker, timelineDurationMs?: number): ZoomMarker {
  const maxTime = timelineDurationMs ?? Number.POSITIVE_INFINITY;
  const annotation = marker.annotation?.replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    ...marker,
    timeMs: Math.round(clamp(marker.timeMs, 0, maxTime)),
    position: { x: clamp(marker.position.x, 0, 1), y: clamp(marker.position.y, 0, 1) },
    scale: Math.round(clamp(marker.scale, ZOOM_LIMITS.scale.min, ZOOM_LIMITS.scale.max) * 100) / 100,
    durationMs: Math.round(clamp(marker.durationMs, ZOOM_LIMITS.durationMs.min, ZOOM_LIMITS.durationMs.max)),
    transitionMs: Math.round(clamp(marker.transitionMs, ZOOM_LIMITS.transitionMs.min, ZOOM_LIMITS.transitionMs.max)),
    annotation: annotation || undefined,
  };
}

/**
 * One zoom effect per eligible click. Clicks that land while the previous effect is still holding
 * extend that effect instead of starting a new zoom-out/zoom-in, and it switches to
 * follow-cursor so it pans to each click. Duplicates are removed first.
 */
export function generateZoomMarkers(
  interactions: InteractionEvent[],
  defaults: MarkerDefaults,
  timelineDurationMs: number,
  now = Date.now(),
): ZoomMarker[] {
  const markers: ZoomMarker[] = [];
  for (const click of dedupeInteractions(interactions)) {
    if (click.type !== 'click' || click.timeMs < 0 || click.timeMs > timelineDurationMs) continue;
    const previous = markers.at(-1);
    if (previous && click.timeMs <= previous.timeMs + previous.durationMs) {
      previous.durationMs = click.timeMs + defaults.durationMs - previous.timeMs;
      previous.positionMode = 'follow-cursor';
      previous.sourceEventIds = [...(previous.sourceEventIds ?? []), click.id];
      continue;
    }
    markers.push({
      id: createId('zm'),
      timeMs: click.timeMs,
      position: { ...click.position },
      scale: defaults.defaultScale,
      durationMs: defaults.durationMs,
      transitionMs: defaults.transitionMs,
      positionMode: 'fixed',
      effect: 'zoom',
      enabled: true,
      origin: 'auto',
      sourceEventIds: [click.id],
      createdAt: now,
      updatedAt: now,
    });
  }
  // Do not hold past the end of the recording.
  return markers.map((marker) => {
    const remaining = timelineDurationMs - marker.timeMs;
    const durationMs = Math.max(ZOOM_LIMITS.durationMs.min, Math.min(marker.durationMs, remaining));
    return normalizeMarker({ ...marker, durationMs }, timelineDurationMs);
  });
}

/** A new manual marker, e.g. "Add at playhead". */
export function createMarker(
  input: { timeMs: number; position?: NormalizedPoint } & Partial<Omit<ZoomMarker, 'id' | 'origin' | 'createdAt' | 'updatedAt'>>,
  defaults: MarkerDefaults,
  timelineDurationMs?: number,
  now = Date.now(),
): ZoomMarker {
  return normalizeMarker(
    {
      positionMode: 'fixed',
      effect: 'zoom',
      enabled: true,
      scale: defaults.defaultScale,
      durationMs: defaults.durationMs,
      transitionMs: defaults.transitionMs,
      ...input,
      position: input.position ?? { x: 0.5, y: 0.5 },
      id: createId('zm'),
      origin: 'manual',
      createdAt: now,
      updatedAt: now,
    },
    timelineDurationMs,
  );
}

export type MarkerPatch = Partial<Omit<ZoomMarker, 'id' | 'origin' | 'createdAt' | 'updatedAt' | 'sourceEventIds'>>;

/** Applies an edit. Edited automatic markers become manual, so regeneration never overwrites user edits. */
export function updateMarker(markers: ZoomMarker[], id: string, patch: MarkerPatch, timelineDurationMs?: number, now = Date.now()): ZoomMarker[] {
  if (!markers.some((marker) => marker.id === id)) throw new Error('This zoom effect no longer exists.');
  return sortMarkers(
    markers.map((marker) =>
      marker.id === id ? normalizeMarker({ ...marker, ...patch, origin: 'manual', updatedAt: now }, timelineDurationMs) : marker,
    ),
  );
}

/** Copies a marker to just after the original (or `timeMs` if given). */
export function duplicateMarker(
  markers: ZoomMarker[],
  id: string,
  timelineDurationMs?: number,
  now = Date.now(),
  timeMs?: number,
): { markers: ZoomMarker[]; copy: ZoomMarker } {
  const original = markers.find((marker) => marker.id === id);
  if (!original) throw new Error('This zoom effect no longer exists.');
  const { endMs } = markerSpan(original);
  const copy = normalizeMarker(
    {
      ...original,
      id: createId('zm'),
      timeMs: timeMs ?? endMs + original.transitionMs,
      origin: 'manual',
      sourceEventIds: undefined,
      createdAt: now,
      updatedAt: now,
    },
    timelineDurationMs,
  );
  return { markers: sortMarkers([...markers, copy]), copy };
}

export function deleteMarker(markers: ZoomMarker[], id: string): ZoomMarker[] {
  return markers.filter((marker) => marker.id !== id);
}

/** Replaces automatic markers with freshly generated ones; manual and edited markers are kept. */
export function regenerateAutoMarkers(
  markers: ZoomMarker[],
  interactions: InteractionEvent[],
  defaults: MarkerDefaults,
  timelineDurationMs: number,
  now = Date.now(),
): ZoomMarker[] {
  const manual = markers.filter((marker) => marker.origin === 'manual');
  return sortMarkers([...manual, ...generateZoomMarkers(interactions, defaults, timelineDurationMs, now)]);
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export interface ZoomState {
  /** 1 when no zoom is active. */
  scale: number;
  /** Clamped focus to centre the view on. */
  focus: NormalizedPoint;
  /** The effect currently applied, if any. */
  marker: ZoomMarker | null;
  /** 0-1 strength of the current effect (useful for highlight opacity). */
  strength: number;
}

/**
 * Zoom applied at a timeline time. When effects overlap, the one that started last wins.
 * Follow-cursor markers pan to the most recent click inside their span.
 */
export function zoomStateAt(markers: ZoomMarker[], timeMs: number, interactions: InteractionEvent[] = []): ZoomState {
  let active: ZoomMarker | null = null;
  for (const marker of markers) {
    if (!marker.enabled) continue;
    const { startMs, endMs } = markerSpan(marker);
    if (timeMs >= startMs && timeMs <= endMs && (!active || marker.timeMs >= active.timeMs)) active = marker;
  }
  if (!active) return { scale: 1, focus: { x: 0.5, y: 0.5 }, marker: null, strength: 0 };

  const holdEnd = active.timeMs + active.durationMs;
  const strength =
    timeMs < active.timeMs
      ? easeInOutCubic(clamp((timeMs - (active.timeMs - active.transitionMs)) / active.transitionMs, 0, 1))
      : timeMs <= holdEnd
        ? 1
        : 1 - easeInOutCubic(clamp((timeMs - holdEnd) / active.transitionMs, 0, 1));

  let focus = active.position;
  if (active.positionMode === 'follow-cursor') {
    const latest = interactions.filter((event) => event.timeMs >= active.timeMs && event.timeMs <= timeMs).at(-1);
    if (latest) focus = latest.position;
  }
  if (active.effect !== 'zoom') return { scale: 1, focus, marker: active, strength };
  const scale = 1 + (active.scale - 1) * strength;
  return { scale, focus: clampFocus(focus, scale), marker: active, strength };
}
