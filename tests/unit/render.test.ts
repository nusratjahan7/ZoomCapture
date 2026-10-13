import { describe, expect, it, vi } from 'vitest';
import {
  cameraFor,
  clampCamera,
  fromOutput,
  IDENTITY_CAMERA,
  isVisible,
  lerpCamera,
  sourceCrop,
  toOutput,
  visibleRegion,
  type Camera,
} from '@/services/render/camera';
import { drawFrame } from '@/services/render/draw';
import {
  cameraAt,
  CLICK_EMPHASIS_MS,
  defaultRenderEffects,
  frameStateAt,
  markerStrength,
  renderEffectsOf,
  type RenderScene,
} from '@/services/render/frameState';
import { fallbackSizes, frameTimestamps, outputSize } from '@/services/render/output';
import { cursorAt, smoothPathAt } from '@/services/render/paths';
import { toCursorSamples, toInteraction } from '@/services/zoom/clicks';
import { pageToFrame } from '@/services/zoom/coordinates';
import { createMarker } from '@/services/zoom/markers';
import type { CursorSample, InteractionEvent, NormalizedPoint, ZoomMarker } from '@/types';

const defaults = { defaultScale: 2, durationMs: 2000, transitionMs: 500 };
const NOW = 1_700_000_000_000;
const marker = (timeMs: number, position: NormalizedPoint, extra: Partial<ZoomMarker> = {}): ZoomMarker => ({
  ...createMarker({ timeMs, position }, defaults, 60_000, NOW + timeMs),
  ...extra,
});
const click = (id: string, timeMs: number, x: number, y: number): InteractionEvent => ({
  id,
  type: 'click',
  timeMs,
  position: { x, y },
  button: 0,
  viewport: { width: 1280, height: 720 },
});
const scene = (markers: ZoomMarker[], extra: Partial<RenderScene> = {}): RenderScene => ({
  markers,
  clicks: [],
  cursor: [],
  effects: { cursorHighlight: false, clickEmphasis: false },
  zoom: true,
  ...extra,
});
const inFrame = (camera: Camera) => {
  const region = visibleRegion(camera);
  return region.x >= -1e-9 && region.y >= -1e-9 && region.x + region.width <= 1 + 1e-9 && region.y + region.height <= 1 + 1e-9;
};
/** Deterministic pseudo-random numbers for property checks. */
function random(seed: number) {
  return () => {
    seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return seed / 4_294_967_296;
  };
}

describe('camera transformation', () => {
  it('centres the view on the focus point', () => {
    const camera = cameraFor({ x: 0.5, y: 0.4 }, 2);
    expect(toOutput({ x: 0.5, y: 0.4 }, camera)).toEqual({ x: 0.5, y: 0.5 });
    const region = visibleRegion(camera);
    expect([region.x, region.y, region.width, region.height].map((value) => value.toFixed(10))).toEqual(['0.2500000000', '0.1500000000', '0.5000000000', '0.5000000000']);
  });

  it('computes the source crop in pixels for any resolution', () => {
    expect(sourceCrop(cameraFor({ x: 0.5, y: 0.5 }, 2), { width: 1920, height: 1080 })).toEqual({ sx: 480, sy: 270, sw: 960, sh: 540 });
    expect(sourceCrop(cameraFor({ x: 0.5, y: 0.5 }, 4), { width: 3840, height: 2160 })).toEqual({ sx: 1440, sy: 810, sw: 960, sh: 540 });
    expect(sourceCrop(IDENTITY_CAMERA, { width: 1280, height: 720 })).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 720 });
  });

  it('moves the view inwards near the edges, never showing anything beyond the frame', () => {
    // Top-left corner at 2×: the crop starts at the corner instead of centring off-frame.
    expect(sourceCrop(cameraFor({ x: 0.02, y: 0.01 }, 2), { width: 1920, height: 1080 })).toEqual({ sx: 0, sy: 0, sw: 960, sh: 540 });
    // Bottom-right at 3×.
    const crop = sourceCrop(cameraFor({ x: 0.99, y: 1 }, 3), { width: 1920, height: 1080 });
    expect(crop.sx + crop.sw).toBeCloseTo(1920, 6);
    expect(crop.sy + crop.sh).toBeCloseTo(1080, 6);
  });

  it('keeps the selected point visible inside the output frame at every position and zoom', () => {
    const next = random(7);
    for (let i = 0; i < 2000; i++) {
      const focus = { x: next(), y: next() };
      const camera = cameraFor(focus, 1.1 + next() * 2.9);
      expect(isVisible(focus, camera)).toBe(true);
      expect(inFrame(camera)).toBe(true);
    }
  });

  it('maps output positions back to the source (inverse transform)', () => {
    const camera = cameraFor({ x: 0.8, y: 0.3 }, 2.5);
    const point = { x: 0.73, y: 0.41 };
    const back = fromOutput(toOutput(point, camera), camera);
    expect(back.x).toBeCloseTo(point.x, 12);
    expect(back.y).toBeCloseTo(point.y, 12);
  });

  it('transitions keep points visible in both framings visible, and stay inside the frame', () => {
    const next = random(11);
    for (let i = 0; i < 300; i++) {
      const a = cameraFor({ x: next(), y: next() }, 1 + next() * 3);
      const b = cameraFor({ x: next(), y: next() }, 1 + next() * 3);
      const shared = { x: next(), y: next() };
      const visibleInBoth = isVisible(shared, a) && isVisible(shared, b);
      for (let k = 0; k <= 1; k += 0.05) {
        const camera = lerpCamera(a, b, k);
        expect(inFrame(camera)).toBe(true);
        if (visibleInBoth) expect(isVisible(shared, camera)).toBe(true);
      }
    }
  });

  it('zooming in towards a point near the edge keeps that point on screen throughout', () => {
    const point = { x: 0.97, y: 0.06 };
    const target = cameraFor(point, 4);
    for (let k = 0; k <= 1; k += 0.01) expect(isVisible(point, lerpCamera(IDENTITY_CAMERA, target, k))).toBe(true);
  });

  it('clamps rounding errors back into the frame', () => {
    expect(clampCamera({ scale: 2, offsetX: -1e-12, offsetY: 1.0000001 })).toEqual({ scale: 2, offsetX: 0, offsetY: 1 });
  });
});

describe('zoom timing', () => {
  const m = marker(2000, { x: 0.3, y: 0.6 }); // transition 500, hold 2000

  it('zooms in before the marker time, holds, then zooms out (eased)', () => {
    const at = (t: number) => cameraAt(scene([m]), t).scale;
    expect(at(1000)).toBe(1);
    expect(at(1500)).toBe(1);
    expect(at(1750)).toBeCloseTo(1.5, 10); // halfway in (ease-in-out is symmetric)
    expect(at(1600)).toBeLessThan(1.5 - 0.25); // slow start
    expect(at(2000)).toBe(2);
    expect(at(3500)).toBe(2);
    expect(at(4250)).toBeCloseTo(1.5, 10);
    expect(at(4500)).toBe(1);
  });

  it('frames the marker position while holding', () => {
    const camera = cameraAt(scene([m]), 3000);
    const position = toOutput({ x: 0.3, y: 0.6 }, camera);
    expect(position.x).toBeCloseTo(0.5, 10);
    expect(position.y).toBeCloseTo(0.5, 10);
  });

  it('ignores disabled effects and the preview toggle shows the full frame', () => {
    expect(cameraAt(scene([{ ...m, enabled: false }]), 3000)).toEqual(IDENTITY_CAMERA);
    expect(cameraAt(scene([m], { zoom: false }), 3000)).toEqual(IDENTITY_CAMERA);
  });

  it('highlight effects do not magnify but draw a highlight at the point', () => {
    const state = frameStateAt(scene([{ ...m, effect: 'highlight' }]), 3000);
    expect(state.camera).toEqual(IDENTITY_CAMERA);
    expect(state.highlight).toEqual({ point: { x: 0.3, y: 0.6 }, strength: 1 });
  });

  it('respects the transition duration and zoom intensity of each effect', () => {
    const slow = marker(5000, { x: 0.5, y: 0.5 }, { transitionMs: 2000, scale: 3 });
    expect(markerStrength(slow, 4000)).toBeCloseTo(0.5, 10);
    expect(cameraAt(scene([slow]), 4000).scale).toBeCloseTo(2, 10);
    expect(cameraAt(scene([slow]), 5000).scale).toBe(3);
  });
});

describe('overlapping effects', () => {
  const a = marker(2000, { x: 0.2, y: 0.2 }, { durationMs: 4000 }); // holds 2000-6000
  const b = marker(4000, { x: 0.8, y: 0.8 }); // 3500-6500, holds 4000-6000

  const maxStep = (markers: ZoomMarker[], from: number, to: number) => {
    let previous = cameraAt(scene(markers), from);
    let max = 0;
    for (let t = from + 1; t <= to; t++) {
      const camera = cameraAt(scene(markers), t);
      max = Math.max(max, Math.abs(camera.scale - previous.scale), Math.abs(camera.offsetX - previous.offsetX), Math.abs(camera.offsetY - previous.offsetY));
      previous = camera;
    }
    return max;
  };

  it('blends between framings without jumps', () => {
    // At 1 ms resolution the camera never moves more than a small step.
    expect(maxStep([a, b], 0, 8000)).toBeLessThan(0.01);
  });

  it('the newer effect takes over and the older one resumes when it ends', () => {
    const holdingA = cameraAt(scene([a, b]), 3000);
    expect(holdingA).toEqual(cameraFor(a.position, 2));
    expect(cameraAt(scene([a, b]), 5000)).toEqual(cameraFor(b.position, 2));
    // A nested, shorter effect: after it ends, the outer effect's framing is back.
    const outer = marker(1000, { x: 0.3, y: 0.3 }, { durationMs: 8000 });
    const inner = marker(3000, { x: 0.7, y: 0.6 }, { durationMs: 1000, scale: 3 });
    expect(cameraAt(scene([outer, inner]), 6000)).toEqual(cameraFor(outer.position, 2));
    expect(maxStep([outer, inner], 0, 10_000)).toBeLessThan(0.01);
  });

  it('is independent of evaluation order (seeking gives the same frame as playing)', () => {
    const playing = [6200, 3100, 4000, 100, 5999].map((t) => cameraAt(scene([a, b]), t));
    const seeking = [100, 3100, 4000, 5999, 6200].map((t) => cameraAt(scene([a, b]), t));
    expect(playing.sort((x, y) => x.scale - y.scale)).toEqual(seeking.sort((x, y) => x.scale - y.scale));
  });
});

describe('follow-cursor', () => {
  const follow = marker(1000, { x: 0.2, y: 0.5 }, { positionMode: 'follow-cursor', durationMs: 6000 });
  const cursor: CursorSample[] = [
    { timeMs: 500, x: 0.2, y: 0.5 },
    { timeMs: 2000, x: 0.8, y: 0.5 },
  ];

  it('pans smoothly to the pointer and settles on it', () => {
    const s = scene([follow], { cursor });
    const centreX = (t: number) => {
      const camera = cameraAt(s, t);
      return (camera.offsetX + 0.5) / camera.scale;
    };
    expect(centreX(1500)).toBeCloseTo(0.25, 10); // clamped at 2×: left half
    expect(centreX(2000)).toBeCloseTo(0.25, 10); // not yet moved
    expect(centreX(2150)).toBeGreaterThan(0.25); // easing towards the pointer
    expect(centreX(2150)).toBeLessThan(0.75);
    expect(centreX(5000)).toBeCloseTo(0.75, 3); // settled (clamped at the right edge)
    let previous = centreX(1900);
    for (let t = 1901; t < 4000; t++) {
      const x = centreX(t);
      expect(Math.abs(x - previous)).toBeLessThan(0.005);
      previous = x;
    }
  });

  it('pans to later clicks for recordings without pointer movement', () => {
    const clicks = [click('a', 1000, 0.2, 0.5), click('b', 3000, 0.8, 0.5)];
    const s = scene([follow], { clicks });
    expect((cameraAt(s, 2500).offsetX + 0.5) / 2).toBeCloseTo(0.25, 10);
    expect((cameraAt(s, 6000).offsetX + 0.5) / 2).toBeCloseTo(0.75, 3);
  });

  it('fixed effects ignore the pointer', () => {
    expect(cameraAt(scene([{ ...follow, positionMode: 'fixed' }], { cursor }), 5000)).toEqual(cameraFor(follow.position, 2));
  });

  it('smoothing is continuous and holds the first value before the path starts', () => {
    const path = [
      { timeMs: 0, x: 0, y: 0 },
      { timeMs: 100, x: 1, y: 1 },
    ];
    expect(smoothPathAt(path, -50, 300)).toEqual({ x: 0, y: 0 });
    expect(smoothPathAt(path, 100, 300).x).toBeCloseTo(0, 10);
    expect(smoothPathAt(path, 100 + 300, 300).x).toBeCloseTo(1 - Math.exp(-1), 2);
    expect(smoothPathAt(path, 100 + 3000, 300).x).toBeCloseTo(1, 6);
  });
});

describe('pointer path', () => {
  const samples: CursorSample[] = [
    { timeMs: 100, x: 0.1, y: 0.1 },
    { timeMs: 140, x: 0.3, y: 0.5 },
    { timeMs: 2000, x: 0.9, y: 0.9 },
    { timeMs: 2030, x: 0, y: 0, hidden: true },
  ];

  it('interpolates between close samples and rests between distant ones', () => {
    expect(cursorAt(samples, 50)).toBeNull();
    const between = cursorAt(samples, 120)!;
    expect(between.x).toBeCloseTo(0.2, 12);
    expect(between.y).toBeCloseTo(0.3, 12);
    expect(cursorAt(samples, 1000)).toEqual({ x: 0.3, y: 0.5 }); // pointer resting, not drifting
    expect(cursorAt(samples, 2010)).toEqual({ x: 0.9, y: 0.9 });
    expect(cursorAt(samples, 2100)).toBeNull(); // left the page
  });

  it('maps page positions into letterboxed video frames', () => {
    // A 4:3 page recorded into 16:9 frames: the page fills the middle 75 % of the width.
    const page = { width: 800, height: 600 };
    const frame = { width: 1920, height: 1080 };
    expect(pageToFrame({ x: 0, y: 0 }, page, frame)).toEqual({ x: 0.125, y: 0 });
    expect(pageToFrame({ x: 1, y: 0.5 }, page, frame)).toEqual({ x: 0.875, y: 0.5 });
    expect(pageToFrame({ x: 0.3, y: 0.7 }, page, { width: 1600, height: 1200 })).toEqual({ x: 0.3, y: 0.7 }); // same shape
    expect(pageToFrame({ x: 0.3, y: 0.7 }, page, null)).toEqual({ x: 0.3, y: 0.7 });
    const click = { epochMs: 0, clientX: 0, clientY: 300, button: 0, viewport: { left: 0, top: 0, ...page }, trusted: true };
    expect(toInteraction(click, 100, 'ev_1', frame)).toMatchObject({ event: { position: { x: 0.125, y: 0.5 } } });
    const samples = toCursorSamples({ viewport: { left: 0, top: 0, ...page }, samples: [{ epochMs: 5, clientX: 800, clientY: 0 }] }, () => 5, frame);
    expect(samples).toEqual([{ timeMs: 5, x: 0.875, y: 0 }]);
  });

  it('converts tracked pointer batches onto the timeline', () => {
    const viewport = { left: 0, top: 0, width: 1000, height: 500 };
    const timeline = (epochMs: number) => (epochMs < 1000 ? null : epochMs - 1000);
    expect(
      toCursorSamples(
        {
          viewport,
          samples: [
            { epochMs: 900, clientX: 10, clientY: 10 }, // before recording: dropped
            { epochMs: 1500, clientX: 250, clientY: 125 },
            { epochMs: 1600, clientX: 2000, clientY: 125 }, // outside the captured page
            { epochMs: 1700, clientX: 500, clientY: 250, hidden: true },
          ],
        },
        timeline,
      ),
    ).toEqual([
      { timeMs: 500, x: 0.25, y: 0.25 },
      { timeMs: 600, x: 0, y: 0, hidden: true },
      { timeMs: 700, x: 0, y: 0, hidden: true },
    ]);
  });
});

describe('overlays', () => {
  const m = marker(2000, { x: 0.3, y: 0.6 }, { annotation: 'Open the menu' });
  const clicks = [click('a', 2000, 0.3, 0.6)];

  it('emphasises clicks at their position in the zoomed frame', () => {
    const s = scene([m], { clicks, effects: { cursorHighlight: false, clickEmphasis: true } });
    const state = frameStateAt(s, 2000 + CLICK_EMPHASIS_MS / 2);
    expect(state.ripples).toHaveLength(1);
    expect(state.ripples[0]!.progress).toBeCloseTo(0.5, 10);
    expect(state.ripples[0]!.point.x).toBeCloseTo(0.5, 10); // the click is centred while zoomed
    expect(frameStateAt(s, 2000 + CLICK_EMPHASIS_MS + 1).ripples).toEqual([]);
    expect(frameStateAt({ ...s, effects: defaultRenderEffects() }, 1999).ripples).toEqual([]);
  });

  it('highlights the cursor only when enabled and tracked', () => {
    const cursor: CursorSample[] = [{ timeMs: 0, x: 0.3, y: 0.6 }];
    expect(frameStateAt(scene([m], { cursor }), 3000).cursor).toBeNull();
    const on = frameStateAt(scene([m], { cursor, effects: { cursorHighlight: true, clickEmphasis: false } }), 3000);
    expect(on.cursor!.x).toBeCloseTo(0.5, 10);
    expect(frameStateAt(scene([m], { effects: { cursorHighlight: true, clickEmphasis: false } }), 3000).cursor).toBeNull();
  });

  it('fades annotations with the effect', () => {
    expect(frameStateAt(scene([m]), 3000).annotation).toEqual({ text: 'Open the menu', opacity: 1 });
    expect(frameStateAt(scene([m]), 1750).annotation!.opacity).toBeCloseTo(0.5, 10);
    expect(frameStateAt(scene([m]), 5000).annotation).toBeNull();
  });

  it('fills in defaults for projects saved before overlays existed', () => {
    expect(renderEffectsOf({})).toEqual({ cursorHighlight: false, clickEmphasis: true });
    expect(renderEffectsOf({ renderEffects: { cursorHighlight: true, clickEmphasis: false } })).toEqual({ cursorHighlight: true, clickEmphasis: false });
  });
});

describe('output', () => {
  it('keeps the aspect ratio, never upscales and uses even dimensions', () => {
    expect(outputSize({ width: 1920, height: 1080 }, 'source')).toEqual({ width: 1920, height: 1080 });
    expect(outputSize({ width: 1920, height: 1080 }, '720p')).toEqual({ width: 1280, height: 720 });
    expect(outputSize({ width: 1280, height: 720 }, '2160p')).toEqual({ width: 1280, height: 720 });
    expect(outputSize({ width: 1365, height: 767 }, 'source')).toEqual({ width: 1366, height: 768 });
    expect(outputSize({ width: 3840, height: 2160 }, '1440p')).toEqual({ width: 2560, height: 1440 });
  });

  it('offers smaller sizes when the encoder rejects high resolutions', () => {
    expect(fallbackSizes({ width: 3840, height: 2160 }, { width: 3840, height: 2160 }).map((size) => size.height)).toEqual([1440, 1080, 720, 480]);
    expect(fallbackSizes({ width: 1280, height: 720 }, { width: 1280, height: 720 }).map((size) => size.height)).toEqual([480]);
  });

  it('renders a constant frame rate over the whole recording', () => {
    const times = frameTimestamps(2, 30);
    expect(times).toHaveLength(60);
    expect(times[1]).toBeCloseTo(1 / 30, 12);
    expect(times.at(-1)).toBeCloseTo(59 / 30, 12);
    expect(frameTimestamps(2.01, 60)).toHaveLength(121);
  });
});

describe('drawing a frame', () => {
  function mockContext() {
    const calls: Array<[string, unknown[]]> = [];
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        calls.push([name, args]);
    const ctx = new Proxy(
      { calls, measureText: (text: string) => ({ width: text.length * 10 }) },
      {
        get(target, key: string) {
          if (key in target) return target[key as keyof typeof target];
          return record(key);
        },
        set: () => true,
      },
    );
    return ctx as unknown as CanvasRenderingContext2D & { calls: typeof calls };
  }

  it('crops the source to the camera view and scales it to the output size', () => {
    const ctx = mockContext();
    const state = frameStateAt(scene([marker(1000, { x: 0.5, y: 0.5 })]), 2000);
    const image = {} as CanvasImageSource;
    drawFrame(ctx, 1280, 720, { layers: [{ image, width: 1920, height: 1080 }] }, state);
    const draws = ctx.calls.filter(([name]) => name === 'drawImage');
    expect(draws).toEqual([['drawImage', [image, 480, 270, 960, 540, 0, 0, 1280, 720]]]);
  });

  it('draws the camera bubble only when a camera frame and layout are given', () => {
    const state = frameStateAt(scene([]), 0);
    const without = mockContext();
    drawFrame(without, 1280, 720, { layers: [] }, state);
    expect(without.calls.some(([name]) => name === 'drawImage')).toBe(false);
    const withCamera = mockContext();
    const camera = {} as CanvasImageSource;
    drawFrame(withCamera, 1280, 720, { layers: [], camera: { image: camera, width: 640, height: 480 }, cameraLayout: { x: 0.9, y: 0.85, size: 'medium' } }, state);
    const draw = withCamera.calls.find(([name]) => name === 'drawImage')!;
    // Centre-cropped square from the 640×480 camera frame, 20 % of the output width.
    expect(draw[1]).toEqual([camera, 80, 0, 480, 480, -128, -128, 256, 256]);
  });

  it('draws click emphasis, cursor highlight and annotations through the camera', () => {
    const ctx = mockContext();
    const arc = vi.fn();
    const state = frameStateAt(
      scene([marker(1000, { x: 0.5, y: 0.5 }, { annotation: 'Hi' })], {
        clicks: [click('a', 1900, 0.5, 0.5)],
        cursor: [{ timeMs: 0, x: 0.75, y: 0.5 }],
        effects: { cursorHighlight: true, clickEmphasis: true },
      }),
      2000,
    );
    drawFrame(new Proxy(ctx, { get: (target, key) => (key === 'arc' ? arc : target[key as keyof typeof target]) }), 1000, 500, { layers: [] }, state);
    // Ripple at the centre (the zoomed click), cursor 0.75 → 1.0 at 2× (right edge).
    expect(arc.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [500, 250],
      [1000, 250],
    ]);
    expect(ctx.calls.some(([name, args]) => name === 'fillText' && args[0] === 'Hi')).toBe(true);
  });
});
