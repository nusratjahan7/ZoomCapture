import { describe, expect, it } from 'vitest';
import { activeVisuals, contentRect, frameSize } from '@/services/render/compose';
import { mapClicksToTimeline, mapCursorToTimeline } from '@/services/timeline/mapping';
import { clipAt, clipDuration, clipEnd, contentDuration, findClip, MIN_CLIP_MS } from '@/services/timeline/model';
import {
  addMediaClip,
  addTextClip,
  addTrack,
  deleteItems,
  duplicateClip,
  moveClip,
  moveTrack,
  nearestFreeStart,
  removeTrack,
  setClipTiming,
  splitAt,
  splitClip,
  TimelineEditError,
  trimClip,
  updateTextClip,
  updateTrack,
  type AssetLookup,
} from '@/services/timeline/operations';
import { snapPoints, snapSpan, snapTime } from '@/services/timeline/snapping';
import type { InteractionEvent, MediaAsset, MediaClip, Timeline, ZoomMarker } from '@/types';

const asset = (id: string, kind: MediaAsset['kind'], durationMs?: number): MediaAsset => ({
  id,
  kind,
  origin: kind === 'screen' || kind === 'microphone' ? 'recording' : 'import',
  mimeType: 'video/webm',
  size: 1,
  durationMs,
  startOffsetMs: 0,
  createdAt: 0,
});
const ASSETS = new Map<string, MediaAsset>([
  ['screen', asset('screen', 'screen', 10_000)],
  ['mic', asset('mic', 'microphone', 10_000)],
  ['song', asset('song', 'audio', 4000)],
  ['logo', asset('logo', 'image')],
  ['clip2', asset('clip2', 'video', 3000)],
]);
const assets: AssetLookup = (id) => ASSETS.get(id);

const media = (id: string, assetId: string, startMs: number, sourceInMs: number, sourceOutMs: number): MediaClip => ({ id, type: 'media', assetId, startMs, sourceInMs, sourceOutMs });
const marker = (id: string, timeMs: number): ZoomMarker => ({
  id,
  timeMs,
  position: { x: 0.5, y: 0.5 },
  scale: 2,
  durationMs: 1000,
  transitionMs: 500,
  positionMode: 'fixed',
  effect: 'zoom',
  enabled: true,
  origin: 'auto',
  createdAt: 0,
  updatedAt: 0,
});

/** A recording's timeline: the screen (10 s), the microphone stem, one zoom effect at 2 s. */
function base(): Timeline {
  return {
    durationMs: 10_000,
    tracks: [
      { id: 'v', kind: 'video', name: 'Screen', clips: [media('s1', 'screen', 0, 0, 10_000)] },
      { id: 'a', kind: 'audio', name: 'Microphone', clips: [media('m1', 'mic', 0, 0, 10_000)] },
    ],
    zoomMarkers: [marker('zm1', 2000)],
  };
}

const clip = (timeline: Timeline, id: string) => findClip(timeline, id)!.clip;

describe('moving clips', () => {
  it('changes only the timeline position, never the source in/out points', () => {
    const t = splitClip(base(), 's1', 4000).timeline; // s1: 0-4 s, right part: 4-10 s
    const rightId = t.tracks[0]!.clips[1]!.id;
    const deleted = deleteItems(t, [rightId]);
    const moved = moveClip(deleted, 's1', { startMs: 2500 }, assets);
    expect(clip(moved, 's1')).toMatchObject({ startMs: 2500, sourceInMs: 0, sourceOutMs: 4000 });
    expect(moved.durationMs).toBe(10_000); // the microphone still runs to 10 s
  });

  it('never overlaps another clip: it lands in the nearest free spot', () => {
    let t = splitClip(base(), 's1', 5000).timeline; // [0-5] [5-10]
    const right = t.tracks[0]!.clips[1]!.id;
    t = deleteItems(t, ['s1']); // [5-10]
    t = addMediaClip(t, ASSETS.get('clip2')!, 0, 'v').timeline; // 3 s clip at 0: [0-3] [5-10]
    const added = t.tracks[0]!.clips[0]!.id;
    // Dropping it at 4 s would overlap [5-10]: it goes to 2 s (its end touches 5 s).
    const moved = moveClip(t, added, { startMs: 4000 }, assets);
    expect(clip(moved, added).startMs).toBe(2000);
    expect(clip(moved, right).startMs).toBe(5000);
    expect(nearestFreeStart(moved.tracks[0]!.clips, 6000, 3000, added)).toBe(10_000);
  });

  it('moves to another compatible track, and refuses incompatible ones', () => {
    let t = addTrack(base(), 'video').timeline;
    const upper = t.tracks[0]!.id;
    t = moveClip(t, 's1', { startMs: 1000, trackId: upper }, assets);
    expect(t.tracks[0]!.clips.map((c) => c.id)).toEqual(['s1']);
    expect(t.tracks.find((track) => track.id === 'v')!.clips).toEqual([]);
    expect(() => moveClip(t, 's1', { startMs: 0, trackId: 'a' }, assets)).toThrow(TimelineEditError);
  });

  it('carries the zoom effects of a moved video clip with it', () => {
    const t = moveClip(deleteItems(base(), ['m1']), 's1', { startMs: 3000 }, assets);
    expect(t.zoomMarkers[0]!.timeMs).toBe(5000);
  });

  it('refuses edits on locked tracks', () => {
    const t = updateTrack(base(), 'v', { locked: true });
    expect(() => moveClip(t, 's1', { startMs: 100 }, assets)).toThrow(/locked/);
    expect(() => deleteItems(t, ['s1'])).toThrow(/locked/);
  });

  it('keeps ids stable and leaves untouched tracks identical', () => {
    const before = deleteItems(base(), []);
    const t = moveClip(deleteItems(before, ['zm1']), 's1', { startMs: 500 }, assets);
    expect(clip(t, 's1').id).toBe('s1');
    expect(t.tracks[1]).toBe(before.tracks[1]);
  });
});

describe('trimming clips', () => {
  it('trimming the start moves the start and the source in-point together', () => {
    const t = trimClip(base(), 's1', 'start', 1500, assets);
    expect(clip(t, 's1')).toMatchObject({ startMs: 1500, sourceInMs: 1500, sourceOutMs: 10_000 });
  });

  it('trimming the end changes only the source out-point', () => {
    const t = trimClip(base(), 's1', 'end', 7000, assets);
    expect(clip(t, 's1')).toMatchObject({ startMs: 0, sourceInMs: 0, sourceOutMs: 7000 });
  });

  it('cannot extend past the media, a neighbour, or below the minimum length', () => {
    const shorter = trimClip(base(), 's1', 'end', 6000, assets);
    expect(clipEnd(clip(trimClip(shorter, 's1', 'end', 99_000, assets), 's1'))).toBe(10_000); // media length
    expect(clip(trimClip(base(), 's1', 'start', -500, assets), 's1').startMs).toBe(0); // source starts at 0
    expect(clipDuration(clip(trimClip(base(), 's1', 'end', 50, assets), 's1'))).toBe(MIN_CLIP_MS);
    const split = splitClip(base(), 's1', 5000).timeline;
    expect(clipEnd(clip(trimClip(trimClip(split, 's1', 'end', 4000, assets), 's1', 'end', 8000, assets), 's1'))).toBe(5000); // neighbour
  });

  it('images can be stretched to any length', () => {
    const t = addMediaClip(base(), ASSETS.get('logo')!, 0).timeline;
    const id = t.tracks[0]!.clips[0]!.id;
    expect(clipDuration(clip(t, id))).toBe(5000);
    expect(clipDuration(clip(trimClip(t, id, 'end', 30_000, assets), id))).toBe(30_000);
  });
});

describe('splitting clips', () => {
  it('splits into two clips that play the same source back to back', () => {
    const { timeline, rightId } = splitClip(base(), 's1', 4000);
    expect(clip(timeline, 's1')).toMatchObject({ startMs: 0, sourceInMs: 0, sourceOutMs: 4000 });
    expect(clip(timeline, rightId)).toMatchObject({ startMs: 4000, sourceInMs: 4000, sourceOutMs: 10_000 });
    expect(rightId).not.toBe('s1');
  });

  it('splits text clips by duration', () => {
    const added = addTextClip(base(), 1000, 'Hello');
    const { timeline, rightId } = splitClip(added.timeline, added.clipId, 2000);
    expect(clip(timeline, added.clipId)).toMatchObject({ startMs: 1000, durationMs: 1000 });
    expect(clip(timeline, rightId)).toMatchObject({ startMs: 2000, durationMs: 1500, text: 'Hello' });
  });

  it('splits every clip under the playhead when nothing is selected', () => {
    const { timeline, rightIds } = splitAt(base(), 3000);
    expect(rightIds).toHaveLength(2);
    expect(timeline.tracks.map((track) => track.clips.length)).toEqual([2, 2]);
  });

  it('refuses a split at the edge or outside a clip', () => {
    expect(() => splitClip(base(), 's1', 50)).toThrow(TimelineEditError);
    expect(() => splitAt(base(), 20_000)).toThrow(/no clip under the playhead/);
  });
});

describe('deleting', () => {
  it('removes clips and zoom effects; the timeline length follows', () => {
    const t = deleteItems(base(), ['s1', 'zm1']);
    expect(t.tracks[0]!.clips).toEqual([]);
    expect(t.zoomMarkers).toEqual([]);
    const all = deleteItems(t, ['m1']);
    expect(all.durationMs).toBe(0);
    expect(contentDuration(all.tracks)).toBe(0);
  });
});

describe('tracks, media and text', () => {
  it('places new media on a free compatible track, adding one when needed', () => {
    const song = addMediaClip(base(), ASSETS.get('song')!, 1000);
    expect(song.timeline.tracks.at(-1)).toMatchObject({ kind: 'music' });
    const again = addMediaClip(song.timeline, ASSETS.get('song')!, 6000);
    expect(again.timeline.tracks.filter((track) => track.kind === 'music')).toHaveLength(1); // room after the first
    const overlap = addMediaClip(again.timeline, ASSETS.get('song')!, 2000);
    expect(overlap.timeline.tracks.filter((track) => track.kind === 'music')).toHaveLength(2);
  });

  it('reorders layers and removes only empty tracks', () => {
    const t = moveTrack(base(), 'a', -1);
    expect(t.tracks.map((track) => track.id)).toEqual(['a', 'v']);
    expect(() => removeTrack(t, 'a')).toThrow(/Only empty tracks/);
    const added = addTrack(t, 'text');
    expect(removeTrack(added.timeline, added.trackId).tracks).toHaveLength(2);
  });

  it('edits text, keeping the position inside the frame', () => {
    const { timeline, clipId } = addTextClip(base(), 0);
    const edited = updateTextClip(timeline, clipId, { text: 'Step 1', position: { x: 2, y: -1 }, style: { size: 'large' } });
    expect(clip(edited, clipId)).toMatchObject({ text: 'Step 1', position: { x: 1, y: 0 }, style: { size: 'large', color: '#ffffff', background: true } });
  });

  it('duplicates into the next free spot and sets exact timing', () => {
    const { timeline, clipId } = addTextClip(base(), 0);
    const copy = duplicateClip(timeline, clipId);
    expect(clip(copy.timeline, copy.copyId).startMs).toBe(2500);
    const timed = setClipTiming(copy.timeline, clipId, { durationMs: 1000 }, assets);
    expect(clipDuration(clip(timed, clipId))).toBe(1000);
  });
});

describe('snapping', () => {
  const points = snapPoints(base(), { playheadMs: 3333, exclude: new Set(['s1']) });

  it('collects edges, the playhead and zoom effect edges', () => {
    // Zoom effect zm1: eases in from 1.5 s, fully zoomed at 2 s, back out at 3.5 s.
    expect(points).toEqual([0, 1500, 2000, 3333, 3500, 10_000]);
  });

  it('snaps within the threshold only, by the nearer edge of a moving span', () => {
    expect(snapTime(points, 3300, 50)).toEqual({ value: 3333, snappedTo: 3333 });
    expect(snapTime(points, 3200, 50)).toEqual({ value: 3200, snappedTo: null });
    expect(snapSpan(points, 1100, 2390, 50)).toEqual({ startMs: 1110, snappedTo: 3500 }); // the end snaps
    expect(snapSpan(points, 1960, 500, 50)).toEqual({ startMs: 2000, snappedTo: 2000 }); // start snaps
  });
});

describe('recorded clicks on the edited timeline', () => {
  const click = (id: string, timeMs: number): InteractionEvent => ({ id, type: 'click', timeMs, position: { x: 0.1, y: 0.2 }, button: 0, viewport: { width: 1, height: 1 } });

  it('follow their moment through cuts and moves, and disappear when cut out', () => {
    // Keep source 2-4 s at timeline 0 s, and source 6-8 s at timeline 5 s.
    const clips = [media('a', 'screen', 0, 2000, 4000), media('b', 'screen', 5000, 6000, 8000)];
    expect(mapClicksToTimeline(clips, [click('c1', 1000), click('c2', 3000), click('c3', 6500)]).map((c) => [c.id, c.timeMs])).toEqual([
      ['c2', 1000],
      ['c3', 5500],
    ]);
  });

  it('pointer path is clipped to each clip and hidden across cuts', () => {
    const clips = [media('a', 'screen', 0, 2000, 4000)];
    const mapped = mapCursorToTimeline(clips, [
      { timeMs: 1000, x: 0.1, y: 0.1 },
      { timeMs: 3000, x: 0.5, y: 0.5 },
      { timeMs: 5000, x: 0.9, y: 0.9 },
    ]);
    expect(mapped).toEqual([
      { timeMs: 0, x: 0.1, y: 0.1 }, // position at the in-point
      { timeMs: 1000, x: 0.5, y: 0.5 },
      { timeMs: 2000, x: 0, y: 0, hidden: true },
    ]);
  });
});

describe('composition', () => {
  it('stacks visible layers bottom-up and finds text and audio at a time', () => {
    let t = addTrack(base(), 'video').timeline;
    t = addMediaClip(t, ASSETS.get('logo')!, 1000, t.tracks[0]!.id).timeline;
    t = addTextClip(t, 1000, 'Hi').timeline;
    const visuals = activeVisuals(t, 2000);
    expect(visuals.layers.map((layer) => layer.clip.assetId)).toEqual(['screen', 'logo']); // screen under logo
    expect(visuals.layers[0]!.sourceMs).toBe(2000);
    expect(visuals.texts.map((text) => text.text)).toEqual(['Hi']);
    expect(activeVisuals(updateTrack(t, 'v', { hidden: true }), 2000).layers.map((layer) => layer.clip.assetId)).toEqual(['logo']);
    expect(clipAt(t.tracks.find((track) => track.id === 'v')!, 10_000)).toBeNull(); // end is exclusive
  });

  it('sizes the output for each aspect ratio and letterboxes the recording into it', () => {
    const source = { width: 1920, height: 1080 };
    expect(frameSize(source, 'source', 'source')).toEqual({ width: 1920, height: 1080 });
    expect(frameSize(source, '9:16', '1080p')).toEqual({ width: 1080, height: 1920 });
    expect(frameSize(source, '1:1', '720p')).toEqual({ width: 720, height: 720 });
    expect(frameSize(source, '16:9', '2160p')).toEqual({ width: 1920, height: 1080 }); // never above the source
    expect(contentRect({ width: 1080, height: 1920 }, source)).toEqual({ x: 0, y: 656.25, width: 1080, height: 607.5 });
  });
});
