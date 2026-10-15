/**
 * Module 07: importing (file checks, PDFs, duplicates), PDF pages and other stills on the
 * timeline, mixed media, voiceover timing, and how zoom effects follow their clips.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { checkSize, classifyFile, fingerprint, IMPORT_LIMITS, sniffType } from '@/services/media/importFiles';
import { PdfError, probePdf, setPdfLibraryLoader } from '@/services/media/pdf';
import { UnsupportedMediaError } from '@/services/media/probe';
import { clampTransform, cropEdge, fittedTransform, placement, resizeFromCorner, setCrop } from '@/services/render/clipFrame';
import { activeVisuals, timelineScene } from '@/services/render/compose';
import { drawFrame } from '@/services/render/draw';
import { frameStateAt } from '@/services/render/frameState';
import { audibleClips, audioPlacement } from '@/services/render/renderVideo';
import { finalizeDraft } from '@/services/recording/finalizeRecording';
import { getAssetBlob } from '@/services/storage/assetRepository';
import { getProject, importProjectAsset } from '@/services/storage/projectRepository';
import { activeMarkers, clipForNewMarker, markerClipId, updateMarkerOnTimeline } from '@/services/timeline/attachment';
import { clipEnd, DEFAULT_STILL_MS, sourceTimeAt } from '@/services/timeline/model';
import {
  addMediaClip,
  addPdfPages,
  deleteItems,
  duplicateClip,
  moveClip,
  setClipTiming,
  setClipTransform,
  splitClip,
  trimClip,
  TimelineEditError,
  updateMediaClip,
  type AssetLookup,
} from '@/services/timeline/operations';
import type { MediaAsset, MediaClip, Timeline, TimelineTrack, ZoomMarker } from '@/types';
import { makePdf, makeWav } from '../fixtures/makePdf.mjs';
import { SCREEN, seedDraft } from './helpers';

beforeAll(() => {
  // The browser build of pdf.js needs a DOM; Node uses its legacy build.
  setPdfLibraryLoader(() => import('pdfjs-dist/legacy/build/pdf.mjs') as never);
});

const asset = (id: string, kind: MediaAsset['kind'], extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  kind,
  origin: kind === 'screen' || kind === 'microphone' ? 'recording' : 'import',
  mimeType: 'application/octet-stream',
  size: 1,
  startOffsetMs: 0,
  createdAt: 0,
  ...extra,
});
const ASSETS = new Map<string, MediaAsset>([
  ['screen', asset('screen', 'screen', { durationMs: 20_000, hasAudio: true })],
  ['deck', asset('deck', 'pdf', { pageCount: 4, hasAudio: false })],
  ['logo', asset('logo', 'image', { width: 800, height: 600, hasAudio: false })],
  ['intro', asset('intro', 'video', { durationMs: 3000, hasAudio: true })],
  ['voice', asset('voice', 'audio', { durationMs: 12_000, hasAudio: true, voiceover: true })],
]);
const lookup: AssetLookup = (id) => ASSETS.get(id);
const media = (id: string, assetId: string, startMs: number, durationMs: number, extra: Partial<MediaClip> = {}): MediaClip => ({
  id,
  type: 'media',
  assetId,
  startMs,
  sourceInMs: 0,
  sourceOutMs: durationMs,
  ...extra,
});
const track = (id: string, kind: TimelineTrack['kind'], clips: MediaClip[]): TimelineTrack => ({ id, kind, name: id, clips });
const timelineOf = (tracks: TimelineTrack[], zoomMarkers: ZoomMarker[] = []): Timeline => ({ tracks, zoomMarkers, durationMs: 20_000 });
const marker = (id: string, timeMs: number, clipId?: string): ZoomMarker => ({
  id,
  timeMs,
  clipId,
  position: { x: 0.5, y: 0.5 },
  scale: 2,
  durationMs: 1000,
  transitionMs: 300,
  positionMode: 'fixed',
  effect: 'zoom',
  enabled: true,
  origin: 'auto',
  createdAt: 0,
  updatedAt: 0,
});
const bytes = (...values: Array<number | string>) =>
  new Uint8Array(values.flatMap((value) => (typeof value === 'string' ? [...value].map((ch) => ch.charCodeAt(0)) : [value])));
const file = (data: Uint8Array | string, name: string, type = '') => Object.assign(new Blob([data as BlobPart], { type }), { name, lastModified: 1 });

describe('checking imported files', () => {
  it('tells what a file is from its contents, not its name', () => {
    expect(sniffType(makePdf([[255, 0, 0]]))).toEqual({ kind: 'pdf', mimeType: 'application/pdf' });
    expect(sniffType(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({ kind: 'image', mimeType: 'image/png' });
    expect(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0))).toEqual({ kind: 'image', mimeType: 'image/jpeg' });
    expect(sniffType(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toEqual({ kind: 'image', mimeType: 'image/webp' });
    expect(sniffType(bytes(0, 0, 0, 0x20, 'ftypisom'))).toEqual({ kind: 'video', mimeType: 'video/mp4' });
    expect(sniffType(bytes(0, 0, 0, 0x20, 'ftypM4A '))).toEqual({ kind: 'audio', mimeType: 'audio/mp4' });
    expect(sniffType(bytes(0x1a, 0x45, 0xdf, 0xa3))).toEqual({ kind: 'video', mimeType: 'video/webm' });
    expect(sniffType(bytes(0x1a, 0x45, 0xdf, 0xa3), 'audio/webm')).toEqual({ kind: 'audio', mimeType: 'audio/webm' });
    expect(sniffType(makeWav(0.1))).toEqual({ kind: 'audio', mimeType: 'audio/wav' });
    expect(sniffType(bytes('ID3', 4, 0))).toEqual({ kind: 'audio', mimeType: 'audio/mpeg' });
    expect(sniffType(bytes('hello world, not media'))).toBeNull();
  });

  it('refuses empty, unknown, misnamed and unplayable files with a reason', async () => {
    await expect(classifyFile(file(new Uint8Array(), 'empty.mp4', 'video/mp4'))).rejects.toThrow(/empty/);
    await expect(classifyFile(file('just some text', 'notes.txt', 'text/plain'))).rejects.toThrow(/Only video, audio, image and PDF/);
    await expect(classifyFile(file('not really a video', 'clip.mp4', 'video/mp4'))).rejects.toThrow(/damaged, or it isn’t really/);
    await expect(classifyFile(file('<svg xmlns="http://www.w3.org/2000/svg"/>', 'logo.svg', 'image/svg+xml'))).rejects.toThrow(/SVG/);
    await expect(classifyFile(file(bytes('RIFF', 0, 0, 0, 0, 'AVI LIST'), 'old.avi', 'video/x-msvideo'))).rejects.toThrow(/AVI videos can’t be played/);
    // A PDF named .png is still a PDF.
    await expect(classifyFile(file(makePdf([[0, 0, 0]]), 'scan.png', 'image/png'))).resolves.toEqual({ kind: 'pdf', mimeType: 'application/pdf' });
    await expect(classifyFile(file(bytes('nothing'), 'x.png', 'image/png'))).rejects.toBeInstanceOf(UnsupportedMediaError);
  });

  it('refuses files over the size limit for their kind', async () => {
    const big = (size: number) => ({ size }) as Blob;
    await expect(checkSize(big(IMPORT_LIMITS.video + 1), 'video')).rejects.toThrow(/Videos up to 2 GB/);
    await expect(checkSize(big(IMPORT_LIMITS.image + 1), 'image')).rejects.toThrow(/Images up to 50 MB/);
    await expect(checkSize(big(IMPORT_LIMITS.pdf + 1), 'pdf')).rejects.toThrow(/PDFs up to 200 MB/);
    await expect(checkSize(big(IMPORT_LIMITS.audio), 'audio')).resolves.toBeUndefined();
  });

  it('fingerprints files, so the same file is recognised', async () => {
    const a = await fingerprint(file(makeWav(0.5), 'a.wav'));
    expect(await fingerprint(file(makeWav(0.5), 'renamed.wav'))).toBe(a);
    expect(await fingerprint(file(makeWav(0.6), 'a.wav'))).not.toBe(a);
  });
});

describe('PDF documents', { timeout: 20_000 }, () => {
  it('reads the number of pages and the page size of a multi-page PDF', async () => {
    const info = await probePdf(new Blob([makePdf([[255, 0, 0], [0, 200, 0], [0, 0, 255]], { width: 960, height: 540 })]));
    expect(info).toEqual({ pageCount: 3, width: 960, height: 540 });
  });

  it('refuses damaged files and files that only claim to be PDFs', async () => {
    await expect(probePdf(new Blob(['%PDF-1.4 this is not a real document']))).rejects.toThrow(PdfError);
    await expect(probePdf(new Blob(['%PDF-1.4 this is not a real document']))).rejects.toThrow(/not a valid PDF, or it is damaged/);
  });

  it('places selected pages one after another, each for the chosen time', () => {
    const base = timelineOf([track('screen', 'video', [media('s', 'screen', 0, 4000)])]);
    const { timeline, clipIds } = addPdfPages(base, ASSETS.get('deck')!, [1, 3, 4], 4000, 2500);
    const clips = timeline.tracks.find((t) => t.id === 'screen')!.clips as MediaClip[];
    expect(clipIds).toHaveLength(3);
    expect(clips.slice(1).map((c) => [c.startMs, clipEnd(c), c.page, c.assetId])).toEqual([
      [4000, 6500, 1, 'deck'],
      [6500, 9000, 3, 'deck'],
      [9000, 11_500, 4, 'deck'],
    ]);
    expect(timeline.durationMs).toBe(11_500);
  });

  it('puts pages on a new video track when there is no room, and refuses bad requests', () => {
    const base = timelineOf([track('screen', 'video', [media('s', 'screen', 0, 20_000)])]);
    const { timeline } = addPdfPages(base, ASSETS.get('deck')!, [2], 1000);
    expect(timeline.tracks).toHaveLength(2);
    expect((timeline.tracks[0]!.clips[0] as MediaClip).page).toBe(2);
    expect(() => addPdfPages(base, ASSETS.get('deck')!, [5], 0)).toThrow(/no page 5/);
    expect(() => addPdfPages(base, ASSETS.get('deck')!, [], 0)).toThrow(TimelineEditError);
    expect(() => addPdfPages(base, ASSETS.get('logo')!, [1], 0)).toThrow(/Only PDF pages/);
  });

  it('lets a page be shown for any length, and its page changed', () => {
    const base = timelineOf([track('slides', 'video', [media('p', 'deck', 0, DEFAULT_STILL_MS, { page: 1 })])]);
    // Stills are not limited by a media length: stretched to 40 s.
    const longer = setClipTiming(base, 'p', { durationMs: 40_000 }, lookup);
    expect(clipEnd(longer.tracks[0]!.clips[0]!)).toBe(40_000);
    const trimmed = trimClip(base, 'p', 'end', 30_000, lookup);
    expect(clipEnd(trimmed.tracks[0]!.clips[0]!)).toBe(30_000);
    expect((updateMediaClip(base, 'p', { page: 3 }).tracks[0]!.clips[0] as MediaClip).page).toBe(3);
    expect(() => updateMediaClip(base, 'p', { page: 0 })).toThrow(/numbered from 1/);
    // Images too.
    const image = addMediaClip(timelineOf([]), ASSETS.get('logo')!, 0, undefined, { durationMs: 7000 });
    expect(clipEnd(image.timeline.tracks[0]!.clips[0]!)).toBe(7000);
  });
});

describe('mixed media and voiceover', () => {
  // Screen 0-6 s, then PDF pages 6-16 s on top, an intro video, a voiceover from 4 s.
  const mixed = timelineOf([
    track('slides', 'video', [media('p1', 'deck', 6000, 5000, { page: 1 }), media('p2', 'deck', 11_000, 5000, { page: 2 })]),
    track('overlay', 'video', [media('logo', 'logo', 0, 2000)]),
    track('screen', 'video', [media('intro', 'intro', 0, 3000), media('s', 'screen', 3000, 3000)]),
    track('voiceover', 'audio', [media('vo', 'voice', 4000, 12_000)]),
  ]);

  it('composes video, images and PDF pages as layers, top track on top', () => {
    expect(activeVisuals(mixed, 1000).layers.map((layer) => layer.clip.id)).toEqual(['intro', 'logo']);
    expect(activeVisuals(mixed, 4000).layers.map((layer) => layer.clip.id)).toEqual(['s']);
    const page = activeVisuals(mixed, 12_000).layers;
    expect(page.map((layer) => [layer.clip.id, (layer.clip as MediaClip).page])).toEqual([['p2', 2]]);
  });

  it('keeps the voiceover playing while a static page is shown', () => {
    // At 12.5 s page 2 is on screen and the voiceover is 8.5 s in.
    expect(activeVisuals(mixed, 12_500).layers[0]!.clip.id).toBe('p2');
    const voiceover = mixed.tracks[3]!.clips[0] as MediaClip;
    expect(sourceTimeAt(voiceover, 12_500)).toBe(8500);
    // Heard in the export (stills have no sound; the intro video and the voiceover do).
    expect(audibleClips(mixed, ASSETS).map(({ clip }) => clip.id).sort()).toEqual(['intro', 's', 'vo']);
  });

  it('places the voiceover at the same moment in the exported sound, across mixing windows', () => {
    const long = { ...media('vo', 'voice', 25_000, 12_000), sourceInMs: 500, sourceOutMs: 12_500 };
    // First 30 s window: starts 25 s in, from 0.5 s of the file, for 5 s.
    expect(audioPlacement(long, 0, 30)).toEqual({ when: 25, offset: 0.5, duration: 5 });
    // Next window continues exactly where it stopped: 5.5 s into the file, for the remaining 7 s.
    expect(audioPlacement(long, 30, 60)).toEqual({ when: 0, offset: 5.5, duration: 7 });
    expect(audioPlacement(long, 60, 90)).toBeNull();
  });
});

describe('zoom effects follow their clips', () => {
  const base = () =>
    timelineOf(
      [
        track('overlay', 'video', [media('img', 'logo', 1000, 3000)]),
        track('screen', 'video', [media('s', 'screen', 0, 10_000)]),
      ],
      [marker('auto', 2000, 's'), marker('legacy', 6000), marker('onImage', 2500, 'img')],
    );

  it('attaches new effects to the clip on screen, older ones to the lowest clip', () => {
    const timeline = base();
    expect(clipForNewMarker(timeline, 2000)).toBe('img');
    expect(clipForNewMarker(timeline, 6000)).toBe('s');
    expect(markerClipId(timeline, timeline.zoomMarkers.find((m) => m.id === 'legacy')!)).toBe('s');
  });

  it('moves effects with their clip only', () => {
    // Moving the image does not take the screen's effect along (it sits over it in time).
    const moved = moveClip(base(), 'img', { startMs: 12_000 }, lookup);
    const times = Object.fromEntries(moved.zoomMarkers.map((m) => [m.id, m.timeMs]));
    expect(times).toEqual({ auto: 2000, legacy: 6000, onImage: 13_500 });
    // Moving the screen clip takes its own effects, including the older unattached one.
    const screen = moveClip(base(), 's', { startMs: 1000 }, lookup);
    expect(Object.fromEntries(screen.zoomMarkers.map((m) => [m.id, m.timeMs]))).toMatchObject({ auto: 3000, legacy: 7000, onImage: 2500 });
  });

  it('splitting gives later effects to the right part; duplicating copies them', () => {
    const { timeline, rightId } = splitClip(base(), 's', 4000);
    expect(timeline.zoomMarkers.find((m) => m.id === 'auto')!.clipId).toBe('s');
    expect(timeline.zoomMarkers.find((m) => m.id === 'legacy')!.clipId).toBe(rightId);
    const { timeline: copied, copyId } = duplicateClip(base(), 'img');
    const copies = copied.zoomMarkers.filter((m) => m.clipId === copyId);
    expect(copies.map((m) => m.timeMs)).toEqual([2500 + 3000]);
  });

  it('deletes effects with their clip, and only applies effects while their clip is on screen', () => {
    expect(deleteItems(base(), ['img']).zoomMarkers.map((m) => m.id).sort()).toEqual(['auto', 'legacy']);
    // Trimming the image so it ends at 2.2 s: its effect at 2.5 s no longer applies (and returns on undo).
    const trimmed = trimClip(base(), 'img', 'end', 2200, lookup);
    expect(activeMarkers(trimmed).map((m) => m.id).sort()).toEqual(['auto', 'legacy']);
    expect(timelineScene({ timeline: trimmed, renderEffects: undefined }, { screenAssetId: 'screen', interactions: [], cursor: [] }).markers.map((m) => m.id)).not.toContain(
      'onImage',
    );
    // Moving an effect attaches it to the clip on screen at its new time.
    const retimed = updateMarkerOnTimeline(base(), 'onImage', { timeMs: 8000 });
    expect(retimed.zoomMarkers.find((m) => m.id === 'onImage')!.clipId).toBe('s');
  });
});

describe('storing imports', () => {
  it('stores a file once per project: importing it again reuses the stored copy', async () => {
    await seedDraft('ses_import', [SCREEN()], 4000);
    const { project } = await finalizeDraft('ses_import');
    const pdf = file(makePdf([[255, 0, 0], [0, 255, 0]]), 'Slides.pdf', 'application/pdf');
    const details = { kind: 'pdf' as const, mimeType: 'application/pdf', info: { pageCount: 2, width: 960, height: 540 }, fingerprint: await fingerprint(pdf) };
    const first = await importProjectAsset(project.id, pdf, details);
    expect(first.reused).toBe(false);
    expect(first.asset).toMatchObject({ kind: 'pdf', pageCount: 2, label: 'Slides.pdf', hasAudio: false });
    const again = await importProjectAsset(project.id, pdf, details);
    expect(again).toEqual({ asset: first.asset, reused: true });
    expect((await getProject(project.id))!.importedAssetIds).toEqual([first.asset.id]);
    // The original bytes are kept as they are.
    const stored = await getAssetBlob(first.asset.id);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(new Uint8Array(await pdf.arrayBuffer()));
  });
});

describe('cropping and moving a clip’s picture', () => {
  const frame = 16 / 9;
  const square = { width: 1000, height: 1000 };

  it('fits a picture inside the frame and centres it when it has no transform', () => {
    expect(fittedTransform(square, frame)).toEqual({ crop: { left: 0, top: 0, right: 0, bottom: 0 }, x: (1 - 9 / 16) / 2, y: 0, width: 9 / 16 });
    // A picture shaped like the frame fills it.
    expect(placement({ width: 1920, height: 1080 }, frame)).toMatchObject({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('keeps the picture’s shape when moved and resized, and part of it in the frame', () => {
    const small = clampTransform({ crop: { left: 0, top: 0, right: 0, bottom: 0 }, x: 0.7, y: 0.6, width: 0.25 }, square, frame);
    const shown = placement(square, frame, small);
    expect(shown.height).toBeCloseTo(0.25 * frame); // square stays square on a 16:9 frame
    // Dragged far off the frame: held with 5 % still inside.
    expect(clampTransform({ ...small, x: 5, y: -5 }, square, frame)).toMatchObject({ x: 0.95, y: Number((0.05 - shown.height).toFixed(4)) });
    // Resizing from the top-left corner keeps the bottom-right corner in place.
    const bigger = resizeFromCorner(small, square, frame, 'top-left', { x: 0.5, y: 0.2 });
    const after = placement(square, frame, bigger);
    expect(after.x + after.width).toBeCloseTo(shown.x + shown.width, 3);
    expect(after.y + after.height).toBeCloseTo(shown.y + shown.height, 3);
    expect(after.width / after.height).toBeCloseTo(shown.width / shown.height, 3);
  });

  it('crops an edge without moving or rescaling the rest of the picture', () => {
    const start = fittedTransform({ width: 1920, height: 1080 }, frame);
    // Cut 10 % of the frame's width from the left: the picture's right edge and scale stay.
    const cut = cropEdge(start, { width: 1920, height: 1080 }, frame, 'left', 0.1);
    expect(cut.crop.left).toBeCloseTo(0.1);
    const shown = placement({ width: 1920, height: 1080 }, frame, cut);
    expect(shown.x).toBeCloseTo(0.1);
    expect(shown.x + shown.width).toBeCloseTo(1);
    expect(shown.sx).toBeCloseTo(192);
    // Cropping the bottom changes only the height.
    const bottom = setCrop(cut, { width: 1920, height: 1080 }, frame, 'bottom', 0.25);
    expect(placement({ width: 1920, height: 1080 }, frame, bottom)).toMatchObject({ y: 0, sh: 810 });
    expect(placement({ width: 1920, height: 1080 }, frame, bottom).height).toBeCloseTo(0.75);
    // Never more than 45 % per edge, 90 % per direction.
    expect(setCrop(start, square, frame, 'left', 0.8).crop.left).toBe(0.45);
  });

  it('draws the cropped part where it was placed, through the zoom camera', () => {
    const calls: unknown[][] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_target, key) => (key === 'drawImage' ? (...args: unknown[]) => calls.push(args) : () => undefined),
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    const image = {} as CanvasImageSource;
    const transform = { crop: { left: 0.5, top: 0, right: 0, bottom: 0.5 }, x: 0.6, y: 0.1, width: 0.3 };
    const state = frameStateAt({ markers: [], clicks: [], cursor: [], effects: { clickEmphasis: false, cursorHighlight: false }, zoom: false }, 0);
    drawFrame(ctx, 1600, 900, { layers: [{ image, width: 800, height: 450, transform }] }, state);
    // Source: the top-right quarter; destination: 30 % wide at (60 %, 10 %), keeping its 16:9 shape.
    expect(calls[0]).toEqual([image, 400, 0, 400, 225, 960, 90, 480, 270]);
  });

  it('stores the transform on clips on video tracks only, and removes it on reset', () => {
    const base = timelineOf([track('slides', 'video', [media('p', 'deck', 0, 5000, { page: 1 })]), track('voice', 'audio', [media('vo', 'voice', 0, 5000)])]);
    const transform = { crop: { left: 0.1, top: 0, right: 0, bottom: 0 }, x: 0.5, y: 0.5, width: 0.4 };
    const moved = setClipTransform(base, 'p', transform);
    expect((moved.tracks[0]!.clips[0] as MediaClip).transform).toEqual(transform);
    // Splitting keeps it on both parts; reset removes it.
    const { timeline: split, rightId } = splitClip(moved, 'p', 2000);
    expect((split.tracks[0]!.clips.find((c) => c.id === rightId) as MediaClip).transform).toEqual(transform);
    expect('transform' in setClipTransform(moved, 'p', undefined).tracks[0]!.clips[0]!).toBe(false);
    expect(() => setClipTransform(base, 'vo', transform)).toThrow(/Only pictures on video tracks/);
  });
});
