import type { ClipTransform } from '@/types';

/**
 * Geometry of a clip's crop and placement in the frame (see `ClipTransform`). Positions are
 * fractions of the frame (the content area the layers are drawn into); `frameAspect` is its
 * width / height. Without a transform a picture is fitted inside the frame and centred, as
 * before Module 07.
 */

export interface Size {
  width: number;
  height: number;
}

export const NO_CROP = { left: 0, top: 0, right: 0, bottom: 0 } as const;
/** Each edge can lose at most this much, and together at most `MAX_CROP_TOTAL`, so something stays. */
const MAX_CROP_EDGE = 0.45;
const MAX_CROP_TOTAL = 0.9;
const MIN_WIDTH = 0.05;
const MAX_WIDTH = 4;
/** At least this much of the picture stays inside the frame. */
const MIN_VISIBLE = 0.05;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

/** Size of the picture left after cropping (same units as `source`). */
export function croppedSize(source: Size, crop: ClipTransform['crop']): Size {
  return {
    width: Math.max(1e-6, source.width * (1 - crop.left - crop.right)),
    height: Math.max(1e-6, source.height * (1 - crop.top - crop.bottom)),
  };
}

/** Height (fraction of the frame) of a picture placed `width` wide, keeping its shape. */
export function placedHeight(width: number, picture: Size, frameAspect: number): number {
  return (width * frameAspect * picture.height) / picture.width;
}

/** The picture fitted inside the frame and centred (what a clip without a transform shows). */
export function fittedTransform(source: Size, frameAspect: number, crop: ClipTransform['crop'] = NO_CROP): ClipTransform {
  const picture = croppedSize(source, crop);
  const width = Math.min(1, picture.width / picture.height / frameAspect);
  const height = placedHeight(width, picture, frameAspect);
  return { crop: { ...crop }, x: (1 - width) / 2, y: (1 - height) / 2, width };
}

/** Keeps a transform usable: crop limits, a sensible size, and part of the picture in the frame. */
export function clampTransform(transform: ClipTransform, source: Size, frameAspect: number): ClipTransform {
  const edge = (value: number) => clamp(value, 0, MAX_CROP_EDGE);
  let { left, top, right, bottom } = transform.crop;
  left = edge(left);
  right = edge(right);
  top = edge(top);
  bottom = edge(bottom);
  if (left + right > MAX_CROP_TOTAL) right = MAX_CROP_TOTAL - left;
  if (top + bottom > MAX_CROP_TOTAL) bottom = MAX_CROP_TOTAL - top;
  const crop = { left, top, right, bottom };
  const width = clamp(transform.width, MIN_WIDTH, MAX_WIDTH);
  const height = placedHeight(width, croppedSize(source, crop), frameAspect);
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return {
    crop: { left: round(left), top: round(top), right: round(right), bottom: round(bottom) },
    x: round(clamp(transform.x, MIN_VISIBLE - width, 1 - MIN_VISIBLE)),
    y: round(clamp(transform.y, MIN_VISIBLE - height, 1 - MIN_VISIBLE)),
    width: round(width),
  };
}

export interface Placement {
  /** Source rectangle (pixels of the picture). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Destination rectangle (fractions of the frame). */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which part of the picture is drawn where, for a clip with or without a transform. */
export function placement(source: Size, frameAspect: number, transform?: ClipTransform): Placement {
  const t = transform ?? fittedTransform(source, frameAspect);
  const picture = croppedSize(source, t.crop);
  return {
    sx: source.width * t.crop.left,
    sy: source.height * t.crop.top,
    sw: picture.width,
    sh: picture.height,
    x: t.x,
    y: t.y,
    width: t.width,
    height: placedHeight(t.width, picture, frameAspect),
  };
}

/**
 * Crops one edge by `delta` (fraction of the frame, positive = inwards) while the rest of the
 * picture stays where it is on screen (its scale doesn't change).
 */
export function cropEdge(transform: ClipTransform, source: Size, frameAspect: number, edge: keyof ClipTransform['crop'], delta: number): ClipTransform {
  const current = placement(source, frameAspect, transform);
  const { crop } = transform;
  const horizontal = edge === 'left' || edge === 'right';
  // Frame fractions per fraction of the whole (uncropped) picture.
  const fullWidth = current.width / (1 - crop.left - crop.right);
  const fullHeight = current.height / (1 - crop.top - crop.bottom);
  const full = horizontal ? fullWidth : fullHeight;
  const limitTotal = MAX_CROP_TOTAL - (horizontal ? crop.left + crop.right : crop.top + crop.bottom);
  const change = clamp(delta / full, -crop[edge], Math.min(MAX_CROP_EDGE - crop[edge], limitTotal));
  const next = { ...crop, [edge]: crop[edge] + change };
  const moved = change * full;
  const x = edge === 'left' ? transform.x + moved : transform.x;
  const y = edge === 'top' ? transform.y + moved : transform.y;
  // Width shrinks with a horizontal crop; a vertical crop changes only the height (derived).
  const width = horizontal ? transform.width - moved : transform.width;
  return clampTransform({ crop: next, x, y, width }, source, frameAspect);
}

/** Sets one edge's crop to `value` (fraction of the picture), keeping the picture's scale. */
export function setCrop(transform: ClipTransform, source: Size, frameAspect: number, edge: keyof ClipTransform['crop'], value: number): ClipTransform {
  const current = placement(source, frameAspect, transform);
  const { crop } = transform;
  const full = edge === 'left' || edge === 'right' ? current.width / (1 - crop.left - crop.right) : current.height / (1 - crop.top - crop.bottom);
  return cropEdge(transform, source, frameAspect, edge, (value - crop[edge]) * full);
}

/** Resizes from a corner, keeping the opposite corner in place and the picture's shape. */
export function resizeFromCorner(
  transform: ClipTransform,
  source: Size,
  frameAspect: number,
  corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
  pointer: { x: number; y: number },
): ClipTransform {
  const current = placement(source, frameAspect, transform);
  const right = current.x + current.width;
  const bottom = current.y + current.height;
  const anchorX = corner.endsWith('left') ? right : current.x;
  const anchorY = corner.startsWith('top') ? bottom : current.y;
  // The larger of the two pointer distances (in width terms) sets the size.
  const ratio = current.height / current.width;
  const byWidth = Math.abs(pointer.x - anchorX);
  const byHeight = Math.abs(pointer.y - anchorY) / ratio;
  const width = clamp(Math.max(byWidth, byHeight), MIN_WIDTH, MAX_WIDTH);
  const height = width * ratio;
  return clampTransform(
    {
      ...transform,
      width,
      x: corner.endsWith('left') ? anchorX - width : anchorX,
      y: corner.startsWith('top') ? anchorY - height : anchorY,
    },
    source,
    frameAspect,
  );
}
