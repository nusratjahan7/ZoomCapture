import { clampFocus, type Size } from '@/services/zoom/coordinates';
import type { NormalizedPoint } from '@/types';

/**
 * The virtual camera: which part of the source frame fills the output frame.
 *
 * A source point p (normalised 0-1) appears in the output at  u = p · scale − offset.
 * The visible part of the source is therefore [offset / scale, (offset + 1) / scale] on each axis.
 *
 * This form is chosen because it is linear in (scale, offset): interpolating two cameras field by
 * field (`lerpCamera`) moves every point on screen along a straight line. So a point visible in
 * both cameras stays visible during the transition, and if neither camera shows anything beyond
 * the frame edges, no camera in between does either (0 ≤ offset ≤ scale − 1 is preserved).
 */
export interface Camera {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export const IDENTITY_CAMERA: Camera = Object.freeze({ scale: 1, offsetX: 0, offsetY: 0 });

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Camera zoomed `scale`× and centred on `focus`, moved inwards near the edges so the view never
 * extends beyond the frame. The focus point itself is always inside the view.
 */
export function cameraFor(focus: NormalizedPoint, scale: number): Camera {
  const s = Math.max(1, scale);
  const centre = clampFocus(focus, s);
  return { scale: s, offsetX: centre.x * s - 0.5, offsetY: centre.y * s - 0.5 };
}

export function lerpCamera(from: Camera, to: Camera, amount: number): Camera {
  const k = clamp(amount, 0, 1);
  return {
    scale: from.scale + (to.scale - from.scale) * k,
    offsetX: from.offsetX + (to.offsetX - from.offsetX) * k,
    offsetY: from.offsetY + (to.offsetY - from.offsetY) * k,
  };
}

/** Guards against rounding: keeps the view inside the frame. */
export function clampCamera(camera: Camera): Camera {
  const scale = Math.max(1, camera.scale);
  return { scale, offsetX: clamp(camera.offsetX, 0, scale - 1), offsetY: clamp(camera.offsetY, 0, scale - 1) };
}

/** Where a source point appears in the output frame (normalised; outside 0-1 means not visible). */
export function toOutput(point: NormalizedPoint, camera: Camera): NormalizedPoint {
  return { x: point.x * camera.scale - camera.offsetX, y: point.y * camera.scale - camera.offsetY };
}

/** The source point shown at an output position (inverse of `toOutput`). */
export function fromOutput(point: NormalizedPoint, camera: Camera): NormalizedPoint {
  return { x: (point.x + camera.offsetX) / camera.scale, y: (point.y + camera.offsetY) / camera.scale };
}

export function isVisible(point: NormalizedPoint, camera: Camera, epsilon = 1e-9): boolean {
  const u = toOutput(point, camera);
  return u.x >= -epsilon && u.y >= -epsilon && u.x <= 1 + epsilon && u.y <= 1 + epsilon;
}

/** The visible region of the source, normalised. */
export function visibleRegion(camera: Camera): { x: number; y: number; width: number; height: number } {
  return { x: camera.offsetX / camera.scale, y: camera.offsetY / camera.scale, width: 1 / camera.scale, height: 1 / camera.scale };
}

/** The crop rectangle in source pixels, as passed to `drawImage(source, sx, sy, sw, sh, …)`. */
export function sourceCrop(camera: Camera, source: Size): { sx: number; sy: number; sw: number; sh: number } {
  const region = visibleRegion(clampCamera(camera));
  return { sx: region.x * source.width, sy: region.y * source.height, sw: region.width * source.width, sh: region.height * source.height };
}
