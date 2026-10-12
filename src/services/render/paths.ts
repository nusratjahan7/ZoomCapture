import type { CursorSample, NormalizedPoint } from '@/types';

/** A position from `timeMs` on (a step), e.g. a cursor sample or a click. Sorted by time. */
export interface PathPoint {
  timeMs: number;
  x: number;
  y: number;
}

/** Pointer samples further apart than this are not interpolated: the pointer was resting. */
export const MAX_INTERPOLATION_GAP_MS = 120;

/** Index of the last point at or before `timeMs`, or -1. Binary search; `points` sorted by time. */
export function indexAtOrBefore(points: ReadonlyArray<{ timeMs: number }>, timeMs: number): number {
  let low = 0;
  let high = points.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (points[mid]!.timeMs <= timeMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * Pointer position at `timeMs`: linear between close samples, resting otherwise. Null before the
 * first sample and while the pointer is outside the page.
 */
export function cursorAt(samples: readonly CursorSample[], timeMs: number): NormalizedPoint | null {
  const index = indexAtOrBefore(samples, timeMs);
  if (index < 0) return null;
  const current = samples[index]!;
  if (current.hidden) return null;
  const next = samples[index + 1];
  if (!next || next.hidden || next.timeMs - current.timeMs > MAX_INTERPOLATION_GAP_MS) return { x: current.x, y: current.y };
  const k = (timeMs - current.timeMs) / (next.timeMs - current.timeMs);
  return { x: current.x + (next.x - current.x) * k, y: current.y + (next.y - current.y) * k };
}

/**
 * Exponentially smoothed position of a step path at `timeMs` (time constant `tauMs`).
 *
 * Stateless: the result depends only on the path and the time, never on which frames were drawn
 * before. So seeking, pausing, changing speed and exporting all give the same camera position
 * for the same moment. Continuous in time, so the camera never jumps. Before the first point the
 * path holds the first point's value. Only the last ~6 τ contribute (the rest weighs < 0.3 %).
 */
export function smoothPathAt(path: readonly PathPoint[], timeMs: number, tauMs: number): NormalizedPoint {
  if (path.length === 0) throw new Error('smoothPathAt needs at least one point');
  const first = path[0]!;
  const last = indexAtOrBefore(path, timeMs);
  if (last < 0 || tauMs <= 0) {
    const point = path[Math.max(0, last)]!;
    return { x: point.x, y: point.y };
  }
  const windowStart = timeMs - tauMs * 6;
  let sumX = 0;
  let sumY = 0;
  let sumWeight = 0;
  let segmentEnd = timeMs;
  for (let index = last; index >= 0 && segmentEnd > windowStart; index--) {
    const point = path[index]!;
    // The first point's value extends back indefinitely.
    const segmentStart = index === 0 ? windowStart : Math.max(point.timeMs, windowStart);
    const weight = Math.exp((segmentEnd - timeMs) / tauMs) - Math.exp((segmentStart - timeMs) / tauMs);
    sumX += weight * point.x;
    sumY += weight * point.y;
    sumWeight += weight;
    segmentEnd = segmentStart;
  }
  return sumWeight > 0 ? { x: sumX / sumWeight, y: sumY / sumWeight } : { x: first.x, y: first.y };
}

/**
 * The step path a follow-cursor effect follows: its own position until `startMs`, then each
 * point after it, limited to what `smoothPathAt` reads at `timeMs`.
 */
export function followPath(
  start: NormalizedPoint,
  startMs: number,
  points: readonly PathPoint[],
  timeMs: number,
  tauMs: number,
): PathPoint[] {
  const from = Math.max(startMs, timeMs - tauMs * 6);
  const firstAfterStart = indexAtOrBefore(points, startMs) + 1;
  const atFrom = indexAtOrBefore(points, from);
  const initial = atFrom >= firstAfterStart ? points[atFrom]! : start;
  const path: PathPoint[] = [{ timeMs: from, x: initial.x, y: initial.y }];
  const end = indexAtOrBefore(points, timeMs);
  for (let index = Math.max(atFrom + 1, firstAfterStart); index <= end; index++) path.push(points[index]!);
  return path;
}
