import type { NormalizedPoint } from '@/types';

export interface Size {
  width: number;
  height: number;
}

/** The visible part of the page, in CSS pixels relative to the layout viewport (see `visualViewport`). */
export interface ViewportRect extends Size {
  left: number;
  top: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Converts a click position (CSS pixels, as in `MouseEvent.clientX/Y`) into a point normalised to
 * the captured content. Tab capture records exactly the visible viewport, so normalising against
 * it (including pinch-zoom offsets) keeps the point aligned with the video at any resolution.
 * Returns null when the point lies outside the recorded content.
 */
export function normalizeViewportPoint(client: { x: number; y: number }, viewport: ViewportRect): NormalizedPoint | null {
  if (!(viewport.width > 0 && viewport.height > 0)) return null;
  const x = (client.x - viewport.left) / viewport.width;
  const y = (client.y - viewport.top) / viewport.height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x, y };
}

export type FitMode = 'contain' | 'cover' | 'stretch';

/**
 * Pixel position of a normalised source point inside an output frame of any size.
 * `contain` letterboxes the source, `cover` crops it to fill, `stretch` ignores aspect ratio.
 * Returns null when `cover` crops the point away.
 */
export function mapToOutput(point: NormalizedPoint, source: Size, output: Size, fit: FitMode = 'contain'): { x: number; y: number } | null {
  if (fit === 'stretch') return { x: point.x * output.width, y: point.y * output.height };
  const ratio =
    fit === 'contain'
      ? Math.min(output.width / source.width, output.height / source.height)
      : Math.max(output.width / source.width, output.height / source.height);
  const width = source.width * ratio;
  const height = source.height * ratio;
  const x = (output.width - width) / 2 + point.x * width;
  const y = (output.height - height) / 2 + point.y * height;
  if (x < 0 || y < 0 || x > output.width || y > output.height) return null;
  return { x, y };
}

/**
 * Centre of the visible window when zoomed `scale`× around `focus`, moved inwards so the zoomed
 * view never shows empty space beyond the frame edges.
 */
export function clampFocus(focus: NormalizedPoint, scale: number): NormalizedPoint {
  if (scale <= 1) return { x: 0.5, y: 0.5 };
  const half = 0.5 / scale;
  return { x: clamp(focus.x, half, 1 - half), y: clamp(focus.y, half, 1 - half) };
}

/**
 * CSS `transform-origin` (0-1) that makes `transform: scale(scale)` centre the view on `focus`.
 * A point p maps to o + s·(p − o); solving o + s·(c − o) = ½ for the clamped focus c gives o.
 */
export function zoomTransformOrigin(focus: NormalizedPoint, scale: number): NormalizedPoint {
  if (scale <= 1) return { x: 0.5, y: 0.5 };
  const c = clampFocus(focus, scale);
  return { x: (0.5 - scale * c.x) / (1 - scale), y: (0.5 - scale * c.y) / (1 - scale) };
}

export function distance(a: NormalizedPoint, b: NormalizedPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
