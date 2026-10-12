import { describe, expect, it } from 'vitest';
import { clampFocus, mapToOutput, normalizeViewportPoint, zoomTransformOrigin } from '@/services/zoom/coordinates';

const viewport = { left: 0, top: 0, width: 1280, height: 720 };

describe('normalizing click positions to the captured content', () => {
  it('maps client pixels to 0-1 relative to the viewport', () => {
    expect(normalizeViewportPoint({ x: 640, y: 360 }, viewport)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizeViewportPoint({ x: 0, y: 0 }, viewport)).toEqual({ x: 0, y: 0 });
    expect(normalizeViewportPoint({ x: 1280, y: 720 }, viewport)).toEqual({ x: 1, y: 1 });
    expect(normalizeViewportPoint({ x: 320, y: 540 }, viewport)).toEqual({ x: 0.25, y: 0.75 });
  });

  it('is independent of the page size, so the same spot gives the same point', () => {
    const small = normalizeViewportPoint({ x: 400, y: 300 }, { left: 0, top: 0, width: 800, height: 600 });
    const large = normalizeViewportPoint({ x: 1200, y: 900 }, { left: 0, top: 0, width: 2400, height: 1800 });
    expect(small).toEqual(large);
  });

  it('accounts for the visible area when the page is pinch-zoomed', () => {
    // Zoomed 2×: the visible region starts at (200, 100) and is 640×360 CSS px.
    const pinched = { left: 200, top: 100, width: 640, height: 360 };
    expect(normalizeViewportPoint({ x: 520, y: 280 }, pinched)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('rejects clicks outside the recorded content', () => {
    expect(normalizeViewportPoint({ x: -1, y: 10 }, viewport)).toBeNull();
    expect(normalizeViewportPoint({ x: 10, y: 721 }, viewport)).toBeNull();
    expect(normalizeViewportPoint({ x: 1281, y: 10 }, viewport)).toBeNull();
    expect(normalizeViewportPoint({ x: 100, y: 50 }, { left: 200, top: 100, width: 640, height: 360 })).toBeNull();
  });

  it('rejects an unusable viewport', () => {
    expect(normalizeViewportPoint({ x: 1, y: 1 }, { left: 0, top: 0, width: 0, height: 720 })).toBeNull();
    expect(normalizeViewportPoint({ x: Number.NaN, y: 1 }, viewport)).toBeNull();
  });
});

describe('mapping normalized points into output sizes', () => {
  const point = { x: 0.25, y: 0.75 };

  it('scales directly when the aspect ratio matches', () => {
    expect(mapToOutput(point, { width: 1280, height: 720 }, { width: 1920, height: 1080 })).toEqual({ x: 480, y: 810 });
    expect(mapToOutput(point, { width: 1280, height: 720 }, { width: 3840, height: 2160 })).toEqual({ x: 960, y: 1620 });
  });

  it('letterboxes with `contain` (4:3 source in a 16:9 output)', () => {
    // 1440×1080 content centred in 1920×1080: 240 px bars left and right.
    expect(mapToOutput(point, { width: 800, height: 600 }, { width: 1920, height: 1080 }, 'contain')).toEqual({ x: 240 + 360, y: 810 });
  });

  it('crops with `cover` and reports points that fall outside the output', () => {
    // 16:9 source covering a square output: 1280×720 → 1080×1080 scale, 420 px cropped each side.
    const cover = (p: { x: number; y: number }) => mapToOutput(p, { width: 1280, height: 720 }, { width: 1080, height: 1080 }, 'cover');
    expect(cover({ x: 0.5, y: 0.5 })).toEqual({ x: 540, y: 540 });
    expect(cover({ x: 0.05, y: 0.5 })).toBeNull();
  });

  it('stretches with `stretch`', () => {
    expect(mapToOutput(point, { width: 800, height: 600 }, { width: 1000, height: 1000 }, 'stretch')).toEqual({ x: 250, y: 750 });
  });
});

describe('keeping the zoomed view inside the frame', () => {
  it('moves a focus near the edge inwards so no empty space shows', () => {
    expect(clampFocus({ x: 0.02, y: 0.98 }, 2)).toEqual({ x: 0.25, y: 0.75 });
    expect(clampFocus({ x: 0.5, y: 0.4 }, 2)).toEqual({ x: 0.5, y: 0.4 });
    expect(clampFocus({ x: 0.1, y: 0.1 }, 1)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('computes a transform-origin that centres the view on the focus', () => {
    for (const [focus, scale] of [
      [{ x: 0.3, y: 0.6 }, 2],
      [{ x: 0.7, y: 0.4 }, 3],
      [{ x: 0.05, y: 0.95 }, 2.5],
    ] as const) {
      const origin = zoomTransformOrigin(focus, scale);
      const c = clampFocus(focus, scale);
      // A point p is drawn at o + s·(p − o): the clamped focus must land at the centre.
      expect(origin.x + scale * (c.x - origin.x)).toBeCloseTo(0.5, 10);
      expect(origin.y + scale * (c.y - origin.y)).toBeCloseTo(0.5, 10);
      expect(origin.x).toBeGreaterThanOrEqual(0);
      expect(origin.x).toBeLessThanOrEqual(1);
    }
  });
});
