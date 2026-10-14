/**
 * Module 08: backgrounds and layouts, camera styling, the audio mix (volumes, fades), subtitles,
 * text overlays and watermarks, custom sizes, and every effect surviving the project reopening.
 */
import { describe, expect, it } from 'vitest';
import { EditorStore } from '@/editor/state/EditorStore';
import { fadeGain, clipGain, gainPoints } from '@/services/render/audioMix';
import { BACKGROUND_PRESETS, drawBackground } from '@/services/render/backgrounds';
import { aspectValue, frameSize } from '@/services/render/compose';
import { drawFrame } from '@/services/render/draw';
import { activeCues, backgroundOf, cameraStyleOf, clampCustomSize, DEFAULT_SUBTITLE_STYLE, frameLayoutOf, layoutRect, subtitleStyleOf } from '@/services/render/enhancements';
import { frameStateAt } from '@/services/render/frameState';
import { finalizeDraft } from '@/services/recording/finalizeRecording';
import { closeDb } from '@/services/storage/db';
import { getProject, saveProjectEdits } from '@/services/storage/projectRepository';
import { addTextClip, updateMediaClip, updateTextClip, updateTrack } from '@/services/timeline/operations';
import { addCue, cuesFromTranscript, deleteCue, replaceCues, toSrt, toVtt, updateCue } from '@/services/timeline/subtitles';
import type { BackgroundStyle, CameraLayout, MediaClip, Project, SubtitleTrack, Timeline } from '@/types';
import { SCREEN, seedDraft } from './helpers';

/** A canvas context that records calls (gradients answer `addColorStop`). */
function recorder() {
  const calls: Array<[string, unknown[]]> = [];
  const values: Record<string, unknown> = {};
  const ctx = new Proxy(values, {
    get(target, key: string) {
      if (key === 'calls') return calls;
      if (key === 'measureText') return (text: string) => ({ width: text.length * 10 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') {
        return (...args: unknown[]) => {
          calls.push([key, args]);
          return { addColorStop: (...stop: unknown[]) => calls.push(['addColorStop', stop]) };
        };
      }
      if (key in target) return target[key];
      return (...args: unknown[]) => calls.push([key, args]);
    },
    set(target, key: string, value) {
      target[key] = value;
      calls.push([`set:${key}`, [value]]);
      return true;
    },
  });
  return ctx as unknown as CanvasRenderingContext2D & { calls: typeof calls };
}
const named = (ctx: { calls: Array<[string, unknown[]]> }, name: string) => ctx.calls.filter(([call]) => call === name).map(([, args]) => args);
const plainState = () => frameStateAt({ markers: [], clicks: [], cursor: [], effects: { clickEmphasis: false, cursorHighlight: false }, zoom: false }, 0);
const BACKGROUND: BackgroundStyle = { ...backgroundOf({}), kind: 'color', color: '#123456' };

describe('backgrounds and layout', () => {
  it('places the recording inside its padding, keeping its shape', () => {
    const frame = { width: 1920, height: 1080 };
    expect(layoutRect(frame, frame)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    // 10 % of the shorter side (108 px) all round: the 16:9 picture shrinks to fit 1704×864.
    const padded = layoutRect(frame, frame, { padding: 0.1, radius: 0, shadow: 0 });
    expect(padded.height).toBeCloseTo(864);
    expect(padded.width).toBeCloseTo(1536);
    expect(padded.x).toBeCloseTo(192);
    expect(padded.y).toBeCloseTo(108);
    // On a square frame the wide recording is letterboxed inside the padding.
    const square = layoutRect({ width: 1000, height: 1000 }, frame, { padding: 0.05, radius: 0, shadow: 0 });
    expect(square.width).toBeCloseTo(900);
    expect(square.height).toBeCloseTo(900 * (1080 / 1920));
  });

  it('draws colours, gradients, every preset and images with fit and focus', () => {
    const colour = recorder();
    drawBackground(colour, 100, 50, BACKGROUND);
    expect(colour.calls.some(([name, args]) => name === 'set:fillStyle' && args[0] === '#123456')).toBe(true);
    const gradient = recorder();
    drawBackground(gradient, 100, 50, { ...BACKGROUND, kind: 'gradient', gradient: { from: '#ff0000', to: '#0000ff', angle: 90 } });
    expect(named(gradient, 'addColorStop')).toEqual([
      [0, '#ff0000'],
      [1, '#0000ff'],
    ]);
    for (const preset of BACKGROUND_PRESETS) {
      const ctx = recorder();
      drawBackground(ctx, 160, 90, { ...BACKGROUND, kind: 'preset', presetId: preset.id });
      expect(ctx.calls.length, preset.id).toBeGreaterThan(3);
    }
    // A 200×100 image covering a 100×100 frame, focused on its right edge.
    const image = recorder();
    const picture = {} as CanvasImageSource;
    drawBackground(image, 100, 100, { ...BACKGROUND, kind: 'image', imageAssetId: 'img', fit: 'cover', position: { x: 1, y: 0.5 } }, { image: picture, width: 200, height: 100 });
    expect(named(image, 'drawImage')).toEqual([[picture, -100, 0, 200, 100]]);
    // Fit (contain), centred: letterboxed top and bottom.
    const fitted = recorder();
    drawBackground(fitted, 100, 100, { ...BACKGROUND, kind: 'image', fit: 'contain', position: { x: 0.5, y: 0.5 } }, { image: picture, width: 200, height: 100 });
    expect(named(fitted, 'drawImage')).toEqual([[picture, 0, 25, 100, 50]]);
  });

  it('draws the background, then the recording with rounded corners and a shadow', () => {
    const ctx = recorder();
    const content = layoutRect({ width: 1600, height: 900 }, { width: 1600, height: 900 }, { padding: 0.1, radius: 0.05, shadow: 1 });
    drawFrame(ctx, 1600, 900, { layers: [], content, background: { style: BACKGROUND }, frameLayout: { padding: 0.1, radius: 0.05, shadow: 1 } }, plainState());
    const order = ctx.calls.map(([name]) => name);
    expect(order.indexOf('set:shadowBlur')).toBeGreaterThan(order.findIndex((name, index) => name === 'set:fillStyle' && ctx.calls[index]![1][0] === '#123456'));
    // Rounded corners: 5 % of the recording's shorter side.
    expect(named(ctx, 'roundRect')[0]).toEqual([content.x, content.y, content.width, content.height, content.height * 0.05]);
  });

  it('supports custom sizes, kept within limits and even', () => {
    expect(clampCustomSize({ width: 1081, height: 99_999 })).toEqual({ width: 1082, height: 4096 });
    expect(aspectValue('custom', { width: 1920, height: 1080 }, { width: 1080, height: 1350 })).toBeCloseTo(0.8);
    expect(frameSize({ width: 1920, height: 1080 }, 'custom', 'source', { width: 1080, height: 1350 })).toEqual({ width: 1080, height: 1350 });
    expect(frameSize({ width: 1920, height: 1080 }, 'custom', '720p', { width: 1080, height: 1350 })).toEqual({ width: 720, height: 900 });
  });
});

describe('camera bubble', () => {
  const camera = { image: {} as CanvasImageSource, width: 640, height: 480 };
  const layout = (patch: Partial<CameraLayout>): CameraLayout => ({ x: 0.5, y: 0.5, size: 'medium', ...patch });

  it('keeps the default look: a circle with a thin white border', () => {
    expect(cameraStyleOf(layout({}))).toMatchObject({ shape: 'circle', aspect: 1, background: null, shadow: 0 });
  });

  it('draws a rounded rectangle with its proportions, cropped from the camera without stretching', () => {
    const ctx = recorder();
    drawFrame(ctx, 1600, 900, { layers: [], camera, cameraLayout: layout({ shape: 'rounded', aspect: 16 / 9, radius: 0.2, scale: 0.25 }) }, plainState());
    // 25 % of 1600 = 400 wide, 225 tall; the 4:3 camera is cropped to 16:9 (640×360).
    const draw = named(ctx, 'drawImage')[0]!;
    expect(draw.slice(1)).toEqual([0, 60, 640, 360, -200, -112.5, 400, 225]);
    expect(named(ctx, 'roundRect').some((args) => args[2] === 400 && args[3] === 225)).toBe(true);
  });

  it('stays inside the frame however it is placed', () => {
    const ctx = recorder();
    drawFrame(ctx, 1600, 900, { layers: [], camera, cameraLayout: layout({ x: 1.2, y: -0.5, scale: 0.2 }) }, plainState());
    // Centre clamped to (1600 − 160, 160): the bubble touches the top-right corner.
    expect(named(ctx, 'translate')).toContainEqual([1440, 160]);
  });

  it('draws a coloured ring and a shadow behind the picture', () => {
    const ctx = recorder();
    drawFrame(ctx, 1600, 900, { layers: [], camera, cameraLayout: layout({ background: '#ff00aa', padding: 0.1, shadow: 1, scale: 0.2 }) }, plainState());
    expect(ctx.calls.some(([name, args]) => name === 'set:fillStyle' && args[0] === '#ff00aa')).toBe(true);
    expect(ctx.calls.some(([name, args]) => name === 'set:shadowBlur' && (args[0] as number) > 0)).toBe(true);
    // The picture is inset by the ring (10 % of 320 px on each side).
    expect(named(ctx, 'drawImage')[0]!.slice(5)).toEqual([-128, -128, 256, 256]);
  });
});

describe('the audio mix', () => {
  const clip: MediaClip = { id: 'm', type: 'media', assetId: 'song', startMs: 1000, sourceInMs: 0, sourceOutMs: 10_000, volume: 0.8, fadeInMs: 2000, fadeOutMs: 4000 };

  it('fades in and out over the clip, and applies clip and track volume', () => {
    expect(fadeGain(clip, 500)).toBe(0);
    expect(fadeGain(clip, 2000)).toBeCloseTo(0.5);
    expect(fadeGain(clip, 6000)).toBe(1);
    expect(fadeGain(clip, 9000)).toBeCloseTo(0.5);
    expect(fadeGain(clip, 11_000)).toBe(0);
    expect(clipGain(clip, { volume: 0.5 }, 6000)).toBeCloseTo(0.4);
    expect(clipGain(clip, { muted: true }, 6000)).toBe(0);
    // Fades longer than half the clip are shortened so they never overlap.
    expect(fadeGain({ ...clip, fadeInMs: 30_000, fadeOutMs: 30_000 }, 6000)).toBeCloseTo(1);
  });

  it('turns the same values into gain automation for the export, window by window', () => {
    expect(gainPoints(clip, {}, 0, 30)).toEqual([
      [1, 0],
      [3, 0.8],
      [7, 0.8],
      [11, expect.closeTo(0, 3)],
    ]);
    // A window starting inside the fade-out continues from the right level.
    const later = gainPoints(clip, {}, 9, 39);
    expect(later[0]![0]).toBe(0);
    expect(later[0]![1]).toBeCloseTo(0.4);
  });

  it('stores fades, opacity and track volume, clamped', () => {
    const timeline: Timeline = { durationMs: 10_000, zoomMarkers: [], tracks: [{ id: 'music', kind: 'music', name: 'Music', clips: [{ ...clip, fadeInMs: 0, fadeOutMs: 0 }] }] };
    const faded = updateMediaClip(timeline, 'm', { fadeInMs: 99_000, fadeOutMs: -5, opacity: 3 });
    expect(faded.tracks[0]!.clips[0]).toMatchObject({ fadeInMs: 30_000, fadeOutMs: 0, opacity: 1 });
    expect(updateTrack(timeline, 'music', { volume: 0.3 }).tracks[0]!.volume).toBe(0.3);
  });
});

describe('subtitles', () => {
  it('adds, edits and deletes cues, kept in order, with line breaks', () => {
    let { subtitles, cueId } = addCue([], 4000, 'Second');
    const first = addCue(subtitles, 1000, 'First\nline two');
    subtitles = first.subtitles;
    expect(subtitles).toHaveLength(1);
    expect(subtitles[0]!.cues.map((cue) => [cue.startMs, cue.endMs, cue.text])).toEqual([
      [1000, 3500, 'First\nline two'],
      [4000, 6500, 'Second'],
    ]);
    subtitles = updateCue(subtitles, cueId, { startMs: 500, endMs: 900, text: 'Moved' });
    expect(subtitles[0]!.cues[0]).toMatchObject({ id: cueId, startMs: 500, endMs: 900, text: 'Moved' });
    expect(() => updateCue(subtitles, cueId, { endMs: 550 })).toThrow(/at least 0.2 s/);
    expect(deleteCue(subtitles, cueId)[0]!.cues).toHaveLength(1);
  });

  it('shows the cues active at a time', () => {
    const { subtitles } = addCue([], 1000, 'Hello');
    expect(activeCues({ subtitles }, 999)).toEqual([]);
    expect(activeCues({ subtitles }, 1000).map((cue) => cue.text)).toEqual(['Hello']);
    expect(activeCues({ subtitles }, 3500)).toEqual([]);
  });

  it('makes cues from a transcript: timed, long parts split, non-speech left out', () => {
    const cues = cuesFromTranscript(
      [
        { text: ' Hello and welcome.', start: 0.5, end: 2 },
        { text: '[Music]', start: 2, end: 4 },
        { text: ' '.padEnd(1) + 'word '.repeat(40).trim(), start: 4, end: 16 },
      ],
      1000,
    );
    expect(cues[0]).toMatchObject({ startMs: 1500, endMs: 3000, text: 'Hello and welcome.' });
    expect(cues.length).toBeGreaterThan(2); // 12 s of speech, 200 characters: split
    expect(cues.slice(1).every((cue) => cue.endMs - cue.startMs <= 6000 && cue.text.length <= 84)).toBe(true);
    expect(cues.at(-1)!.endMs).toBe(17_000);
    // Generated cues replace the old ones in their stretch only.
    const kept = addCue([], 30_000, 'Keep me').subtitles;
    expect(replaceCues(kept, cues, 0, 20_000)[0]!.cues.map((cue) => cue.text)).toContain('Keep me');
  });

  it('exports SubRip and WebVTT', () => {
    const { subtitles } = addCue([], 3_723_456, 'Line one\nLine two', 1544);
    const cues = subtitles[0]!.cues;
    expect(toSrt(cues)).toBe('1\n01:02:03,456 --> 01:02:05,000\nLine one\nLine two\n');
    expect(toVtt(cues)).toBe('WEBVTT\n\n01:02:03.456 --> 01:02:05.000\nLine one\nLine two\n');
  });

  it('draws subtitles with their style: font, box, position', () => {
    const ctx = recorder();
    drawFrame(ctx, 1000, 500, { layers: [], subtitles: { lines: ['Hello there'], style: { ...DEFAULT_SUBTITLE_STYLE, font: 'serif', position: 'top', background: '#112233' } } }, plainState());
    expect(named(ctx, 'fillText')[0]![0]).toBe('Hello there');
    expect(ctx.calls.some(([name, args]) => name === 'set:font' && String(args[0]).includes('Georgia'))).toBe(true);
    expect(ctx.calls.some(([name, args]) => name === 'set:fillStyle' && args[0] === '#112233')).toBe(true);
    // Hidden subtitles are not drawn.
    const hidden = recorder();
    drawFrame(hidden, 1000, 500, { layers: [], subtitles: { lines: ['Hello'], style: { ...DEFAULT_SUBTITLE_STYLE, visible: false } } }, plainState());
    expect(named(hidden, 'fillText')).toEqual([]);
  });
});

describe('text overlays and watermarks', () => {
  it('draws a callout arrow from the text to its target, with font and opacity', () => {
    const base: Timeline = { durationMs: 5000, zoomMarkers: [], tracks: [] };
    const { timeline, clipId } = addTextClip(base, 0, 'Click here');
    const callout = updateTextClip(timeline, clipId, { position: { x: 0.2, y: 0.2 }, callout: { target: { x: 1.5, y: 0.8 } }, style: { font: 'mono', opacity: 2 } });
    const clip = callout.tracks[0]!.clips[0]!;
    expect(clip).toMatchObject({ callout: { target: { x: 1, y: 0.8 } }, style: { font: 'mono', opacity: 1 } });
    const ctx = recorder();
    drawFrame(ctx, 1000, 500, { layers: [], texts: [clip as never] }, plainState());
    // The arrow line ends next to the target (1000, 400), and its head is drawn there.
    expect(named(ctx, 'moveTo').some((args) => args[0] === 1000 && args[1] === 400)).toBe(true);
    expect(ctx.calls.some(([name, args]) => name === 'set:font' && String(args[0]).includes('Consolas'))).toBe(true);
    // null turns it back into plain text.
    expect('callout' in updateTextClip(callout, clipId, { callout: null }).tracks[0]!.clips[0]!).toBe(false);
  });

  it('draws a picture with its opacity (a semi-transparent logo)', () => {
    const ctx = recorder();
    drawFrame(ctx, 1600, 900, { layers: [{ image: {} as CanvasImageSource, width: 400, height: 200, opacity: 0.4 }] }, plainState());
    expect(ctx.calls.some(([name, args]) => name === 'set:globalAlpha' && args[0] === 0.4)).toBe(true);
  });
});

describe('effects survive reopening the project', () => {
  it('saves every enhancement, and reads it back after the database is closed', async () => {
    await seedDraft('ses_m08', [SCREEN()], 4000);
    const { project } = await finalizeDraft('ses_m08');
    const store = new EditorStore(project, async (id, edits) => saveProjectEdits(id, edits), () => undefined);
    const subtitles: SubtitleTrack[] = addCue([], 500, 'Hello\nworld').subtitles;
    store.edit('Enhance', (p): Project => {
      const text = addTextClip(p.timeline, 0, '© ACME');
      let timeline = updateTextClip(text.timeline, text.clipId, { style: { font: 'serif', opacity: 0.6 }, callout: { target: { x: 0.9, y: 0.9 } } });
      const screen = timeline.tracks.find((track) => track.kind === 'video')!;
      timeline = updateTrack(timeline, screen.id, { volume: 0.4 });
      timeline = updateMediaClip(timeline, screen.clips[0]!.id, { fadeInMs: 500, fadeOutMs: 800, opacity: 0.9 });
      return {
        ...p,
        aspectRatio: 'custom',
        customSize: { width: 1080, height: 1350 },
        background: { ...backgroundOf(p), kind: 'gradient', gradient: { from: '#111111', to: '#999999', angle: 45 } },
        frameLayout: { padding: 0.08, radius: 0.03, shadow: 0.5 },
        cameraLayout: { x: 0.8, y: 0.8, size: 'medium', scale: 0.22, shape: 'rounded', aspect: 4 / 3, radius: 0.2, borderWidth: 0.02, borderColor: '#ffcc00', shadow: 0.7, background: '#7c5cff', padding: 0.05 },
        subtitleStyle: { ...subtitleStyleOf(p), font: 'rounded', position: 'top', color: '#ffff00' },
        subtitles,
        timeline,
      };
    });
    const edited = store.project;
    await store.flush();
    store.dispose();
    await closeDb();

    const reopened = (await getProject(project.id))!;
    for (const key of ['aspectRatio', 'customSize', 'background', 'frameLayout', 'cameraLayout', 'subtitleStyle', 'subtitles', 'timeline'] as const) {
      expect(reopened[key], key).toEqual(edited[key]);
    }
    expect(frameLayoutOf(reopened).padding).toBe(0.08);
    // Older projects (none of these fields) get defaults that look as before.
    expect(backgroundOf({}).kind).toBe('none');
    expect(frameLayoutOf({})).toEqual({ padding: 0, radius: 0, shadow: 0 });
    expect(subtitleStyleOf({}).visible).toBe(true);
  });
});
