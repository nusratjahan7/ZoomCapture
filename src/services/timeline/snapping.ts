import { markerSpan } from '@/services/zoom/markers';
import type { Timeline } from '@/types';
import { clipEnd } from './model';

/**
 * Snapping: while dragging, edges jump to nearby points of interest (timeline start, playhead,
 * clip edges, zoom effect edges) when within a few pixels, which makes cuts line up exactly.
 */

/** Points to snap to, excluding the items being dragged. Sorted, without duplicates. */
export function snapPoints(timeline: Timeline, options: { playheadMs?: number; exclude?: ReadonlySet<string> } = {}): number[] {
  const points = new Set<number>([0]);
  if (options.playheadMs !== undefined) points.add(Math.round(options.playheadMs));
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (options.exclude?.has(clip.id)) continue;
      points.add(clip.startMs);
      points.add(clipEnd(clip));
    }
  }
  for (const marker of timeline.zoomMarkers) {
    if (options.exclude?.has(marker.id)) continue;
    const span = markerSpan(marker);
    points.add(marker.timeMs);
    points.add(span.startMs);
    points.add(span.endMs);
  }
  return [...points].sort((a, b) => a - b);
}

/** The point nearest to `value` within `thresholdMs`, or null. */
export function nearestPoint(points: readonly number[], value: number, thresholdMs: number): number | null {
  let best: number | null = null;
  for (const point of points) {
    const distance = Math.abs(point - value);
    if (distance <= thresholdMs && (best === null || distance < Math.abs(best - value))) best = point;
  }
  return best;
}

/** Snaps a single time (a trim edge, the playhead). */
export function snapTime(points: readonly number[], value: number, thresholdMs: number): { value: number; snappedTo: number | null } {
  const point = nearestPoint(points, value, thresholdMs);
  return point === null ? { value, snappedTo: null } : { value: point, snappedTo: point };
}

/** Snaps a moving span by whichever edge is closer to a point; returns the adjusted start. */
export function snapSpan(points: readonly number[], startMs: number, durationMs: number, thresholdMs: number): { startMs: number; snappedTo: number | null } {
  const start = nearestPoint(points, startMs, thresholdMs);
  const end = nearestPoint(points, startMs + durationMs, thresholdMs);
  const startDistance = start === null ? Number.POSITIVE_INFINITY : Math.abs(start - startMs);
  const endDistance = end === null ? Number.POSITIVE_INFINITY : Math.abs(end - (startMs + durationMs));
  if (start !== null && startDistance <= endDistance) return { startMs: start, snappedTo: start };
  if (end !== null) return { startMs: end - durationMs, snappedTo: end };
  return { startMs, snappedTo: null };
}
