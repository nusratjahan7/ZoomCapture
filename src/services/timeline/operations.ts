import { markerSpan } from '@/services/zoom/markers';
import { markerClipId } from './attachment';
import type { MediaAsset, MediaClip, NormalizedPoint, TextClip, TextStyle, Timeline, TimelineClip, TimelineTrack, TrackKind } from '@/types';
import { createId } from '@/utils/id';
import {
  acceptsClip,
  clipDuration,
  clipEnd,
  contentDuration,
  DEFAULT_STILL_MS,
  findClip,
  hasFixedLength,
  MIN_CLIP_MS,
  TRACK_NAMES,
  trackKindsFor,
} from './model';

/**
 * Timeline editing operations. Each is a pure function: it returns a new timeline and never
 * mutates its input, so every result can be kept for undo. Unchanged tracks and clips keep their
 * identity (cheap comparisons, predictable React updates). Ids are stable: a moved or trimmed clip
 * keeps its id; a split keeps the id on the left part and gives the right part a new one.
 * Invalid edits throw `TimelineEditError` with a message for the user.
 */

export class TimelineEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineEditError';
  }
}

/** What operations need to know about assets (kind and length). */
export type AssetLookup = (assetId: string) => Pick<MediaAsset, 'id' | 'kind' | 'durationMs' | 'label'> | undefined;

const round = (ms: number) => Math.round(ms);

function finish(timeline: Timeline, tracks: TimelineTrack[], zoomMarkers = timeline.zoomMarkers): Timeline {
  return { ...timeline, tracks, zoomMarkers, durationMs: contentDuration(tracks) };
}

function sortClips(clips: TimelineClip[]): TimelineClip[] {
  return [...clips].sort((a, b) => a.startMs - b.startMs);
}

function replaceTrack(tracks: TimelineTrack[], trackId: string, next: TimelineTrack): TimelineTrack[] {
  return tracks.map((track) => (track.id === trackId ? next : track));
}

function requireClip(timeline: Timeline, clipId: string) {
  const found = findClip(timeline, clipId);
  if (!found) throw new TimelineEditError('This item no longer exists.');
  if (found.track.locked) throw new TimelineEditError(`The “${found.track.name}” track is locked.`);
  return found;
}

function overlaps(clips: readonly TimelineClip[], startMs: number, endMs: number, ignoreId?: string): boolean {
  return clips.some((clip) => clip.id !== ignoreId && startMs < clipEnd(clip) && endMs > clip.startMs);
}

/**
 * The start closest to `desired` at which a clip of `duration` fits on the track without
 * overlapping anything (and not before 0), or null if there is no room nearby.
 */
export function nearestFreeStart(clips: readonly TimelineClip[], desired: number, duration: number, ignoreId?: string): number | null {
  const candidates = [Math.max(0, desired)];
  for (const clip of clips) {
    if (clip.id === ignoreId) continue;
    candidates.push(clipEnd(clip), clip.startMs - duration);
  }
  let best: number | null = null;
  for (const candidate of candidates) {
    if (candidate < 0 || overlaps(clips, candidate, candidate + duration, ignoreId)) continue;
    if (best === null || Math.abs(candidate - desired) < Math.abs(best - desired)) best = candidate;
  }
  return best === null ? null : round(best);
}

export interface MoveTarget {
  startMs: number;
  /** Another track of a compatible kind; defaults to the clip's own track. */
  trackId?: string;
}

/**
 * Moves a clip in time (and optionally to another compatible track). If the spot is taken, the
 * clip goes to the nearest free spot. Zoom effects that start during a moved video clip move with
 * it, so they stay on the content they were made for.
 */
export function moveClip(timeline: Timeline, clipId: string, target: MoveTarget, assets: AssetLookup): Timeline {
  const { track, clip } = requireClip(timeline, clipId);
  const destination = target.trackId ? timeline.tracks.find((candidate) => candidate.id === target.trackId) : track;
  if (!destination) throw new TimelineEditError('That track no longer exists.');
  if (destination.locked) throw new TimelineEditError(`The “${destination.name}” track is locked.`);
  const assetKind = clip.type === 'media' ? assets(clip.assetId)?.kind : undefined;
  if (!acceptsClip(destination, clip, assetKind)) {
    throw new TimelineEditError(`This clip can’t go on a ${TRACK_NAMES[destination.kind].toLowerCase()} track.`);
  }
  const duration = clipDuration(clip);
  const startMs = nearestFreeStart(destination.clips, round(target.startMs), duration, clip.id);
  if (startMs === null) throw new TimelineEditError('There is no room for this clip there.');
  if (startMs === clip.startMs && destination.id === track.id) return timeline;

  const moved = { ...clip, startMs };
  let tracks = timeline.tracks;
  if (destination.id === track.id) {
    tracks = replaceTrack(tracks, track.id, { ...track, clips: sortClips(track.clips.map((c) => (c.id === clip.id ? moved : c))) });
  } else {
    tracks = replaceTrack(tracks, track.id, { ...track, clips: track.clips.filter((c) => c.id !== clip.id) });
    tracks = replaceTrack(tracks, destination.id, { ...destination, clips: sortClips([...destination.clips, moved]) });
  }

  // Zoom effects belong to a clip (see attachment.ts): they move with it.
  const delta = startMs - clip.startMs;
  const markers = timeline.zoomMarkers.map((marker) =>
    markerClipId(timeline, marker) === clip.id ? { ...marker, clipId: clip.id, timeMs: marker.timeMs + delta } : marker,
  );
  return finish(timeline, tracks, markers);
}

/**
 * Trims the start or end of a clip to `timeMs` (timeline time). The result is clamped: never past
 * a neighbouring clip, never beyond the asset's own media, never shorter than `MIN_CLIP_MS`.
 * Trimming the start moves the clip's start and its source in-point together, so the picture at
 * every remaining moment is unchanged.
 */
export function trimClip(timeline: Timeline, clipId: string, edge: 'start' | 'end', timeMs: number, assets: AssetLookup): Timeline {
  const { track, clip, index } = requireClip(timeline, clipId);
  const previousEnd = index > 0 ? clipEnd(track.clips[index - 1]!) : 0;
  const nextStart = index < track.clips.length - 1 ? track.clips[index + 1]!.startMs : Number.POSITIVE_INFINITY;
  const end = clipEnd(clip);
  let updated: TimelineClip;

  if (clip.type === 'media') {
    const asset = assets(clip.assetId);
    const fixed = asset ? hasFixedLength(asset) : true;
    const mediaLength = fixed ? (asset?.durationMs ?? clip.sourceOutMs) : Number.POSITIVE_INFINITY;
    if (edge === 'start') {
      // An image has no source time: its start can extend freely (source stays at 0).
      const earliest = fixed ? Math.max(previousEnd, clip.startMs - clip.sourceInMs) : previousEnd;
      const startMs = round(Math.min(Math.max(timeMs, earliest), end - MIN_CLIP_MS));
      const shift = startMs - clip.startMs;
      updated = fixed
        ? { ...clip, startMs, sourceInMs: clip.sourceInMs + shift }
        : { ...clip, startMs, sourceInMs: 0, sourceOutMs: clip.sourceOutMs - shift };
    } else {
      const latest = Math.min(nextStart, clip.startMs + (mediaLength - clip.sourceInMs));
      const endMs = round(Math.max(Math.min(timeMs, latest), clip.startMs + MIN_CLIP_MS));
      updated = { ...clip, sourceOutMs: clip.sourceInMs + (endMs - clip.startMs) };
    }
  } else if (edge === 'start') {
    const startMs = round(Math.min(Math.max(timeMs, previousEnd), end - MIN_CLIP_MS));
    updated = { ...clip, startMs, durationMs: end - startMs };
  } else {
    const endMs = round(Math.max(Math.min(timeMs, nextStart), clip.startMs + MIN_CLIP_MS));
    updated = { ...clip, durationMs: endMs - clip.startMs };
  }
  return finish(timeline, replaceTrack(timeline.tracks, track.id, { ...track, clips: track.clips.map((c) => (c.id === clip.id ? updated : c)) }));
}

/** Splits a clip in two at `atMs`. The left part keeps the id; returns the right part's id. */
export function splitClip(timeline: Timeline, clipId: string, atMs: number): { timeline: Timeline; rightId: string } {
  const { track, clip } = requireClip(timeline, clipId);
  const at = round(atMs);
  if (at < clip.startMs + MIN_CLIP_MS || at > clipEnd(clip) - MIN_CLIP_MS) {
    throw new TimelineEditError('Move the playhead inside the clip (away from its edges) to split it.');
  }
  const rightId = createId('clp');
  let left: TimelineClip;
  let right: TimelineClip;
  if (clip.type === 'media') {
    const cut = clip.sourceInMs + (at - clip.startMs);
    left = { ...clip, sourceOutMs: cut };
    right = { ...clip, id: rightId, startMs: at, sourceInMs: cut };
  } else {
    left = { ...clip, durationMs: at - clip.startMs };
    right = { ...clip, id: rightId, startMs: at, durationMs: clipEnd(clip) - at };
  }
  const clips = track.clips.flatMap((c) => (c.id === clip.id ? [left, right] : [c]));
  // Zoom effects of the clip after the cut now belong to the right-hand part.
  const markers = timeline.zoomMarkers.map((marker) =>
    markerClipId(timeline, marker) === clip.id ? { ...marker, clipId: marker.timeMs >= at ? rightId : clip.id } : marker,
  );
  return { timeline: finish(timeline, replaceTrack(timeline.tracks, track.id, { ...track, clips }), markers), rightId };
}

/**
 * Splits at the playhead: the given clips, or (with none given) every clip under the playhead on
 * unlocked tracks. Returns the ids of the new right-hand parts.
 */
export function splitAt(timeline: Timeline, atMs: number, clipIds?: readonly string[]): { timeline: Timeline; rightIds: string[] } {
  const targets =
    clipIds && clipIds.length > 0
      ? [...clipIds]
      : timeline.tracks.filter((track) => !track.locked).flatMap((track) => track.clips.filter((c) => atMs > c.startMs && atMs < clipEnd(c)).map((c) => c.id));
  if (targets.length === 0) throw new TimelineEditError('There is no clip under the playhead to split.');
  let current = timeline;
  const rightIds: string[] = [];
  for (const id of targets) {
    const result = splitClip(current, id, atMs);
    current = result.timeline;
    rightIds.push(result.rightId);
  }
  return { timeline: current, rightIds };
}

/** Removes clips and/or zoom effects. Items on locked tracks are refused. */
export function deleteItems(timeline: Timeline, ids: readonly string[]): Timeline {
  const remove = new Set(ids);
  for (const track of timeline.tracks) {
    if (track.locked && track.clips.some((clip) => remove.has(clip.id))) throw new TimelineEditError(`The “${track.name}” track is locked.`);
  }
  const tracks = timeline.tracks.map((track) =>
    track.clips.some((clip) => remove.has(clip.id)) ? { ...track, clips: track.clips.filter((clip) => !remove.has(clip.id)) } : track,
  );
  // Zoom effects are deleted with the clip they belong to.
  const markers = timeline.zoomMarkers.filter((marker) => {
    if (remove.has(marker.id)) return false;
    const owner = markerClipId(timeline, marker);
    return owner === null || !remove.has(owner);
  });
  return finish(timeline, tracks, markers.length === timeline.zoomMarkers.length ? timeline.zoomMarkers : markers);
}

/** Copies a clip into the nearest free spot after it on the same track. */
export function duplicateClip(timeline: Timeline, clipId: string): { timeline: Timeline; copyId: string } {
  const { track, clip } = requireClip(timeline, clipId);
  const startMs = nearestFreeStart(track.clips, clipEnd(clip), clipDuration(clip));
  if (startMs === null) throw new TimelineEditError('There is no room on this track for a copy.');
  const copy = { ...clip, id: createId('clp'), startMs };
  // The copy gets copies of the clip's zoom effects.
  const delta = startMs - clip.startMs;
  const now = Date.now();
  const copiedMarkers = timeline.zoomMarkers
    .filter((marker) => markerClipId(timeline, marker) === clip.id)
    .map((marker) => ({ ...marker, id: createId('zm'), clipId: copy.id, timeMs: marker.timeMs + delta, origin: 'manual' as const, sourceEventIds: undefined, createdAt: now, updatedAt: now }));
  const markers = copiedMarkers.length ? [...timeline.zoomMarkers, ...copiedMarkers].sort((a, b) => a.timeMs - b.timeMs) : timeline.zoomMarkers;
  return {
    timeline: finish(timeline, replaceTrack(timeline.tracks, track.id, { ...track, clips: sortClips([...track.clips, copy]) }), markers),
    copyId: copy.id,
  };
}

export function addTrack(timeline: Timeline, kind: TrackKind, index?: number): { timeline: Timeline; trackId: string } {
  const sameKind = timeline.tracks.filter((track) => track.kind === kind).length;
  const track: TimelineTrack = { id: createId('trk'), kind, name: sameKind ? `${TRACK_NAMES[kind]} ${sameKind + 1}` : TRACK_NAMES[kind], clips: [] };
  const tracks = [...timeline.tracks];
  // New visual tracks go on top; audio tracks at the bottom (unless an index is given).
  tracks.splice(index ?? (kind === 'audio' || kind === 'music' ? tracks.length : 0), 0, track);
  return { timeline: { ...timeline, tracks }, trackId: track.id };
}

export function removeTrack(timeline: Timeline, trackId: string): Timeline {
  const track = timeline.tracks.find((candidate) => candidate.id === trackId);
  if (!track) return timeline;
  if (track.clips.length > 0) throw new TimelineEditError('Only empty tracks can be removed. Delete or move its clips first.');
  return finish(timeline, timeline.tracks.filter((candidate) => candidate.id !== trackId));
}

/** Moves a track up (towards the top layer) or down. */
export function moveTrack(timeline: Timeline, trackId: string, direction: -1 | 1): Timeline {
  const index = timeline.tracks.findIndex((track) => track.id === trackId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= timeline.tracks.length) return timeline;
  const tracks = [...timeline.tracks];
  [tracks[index], tracks[target]] = [tracks[target]!, tracks[index]!];
  return { ...timeline, tracks };
}

export type TrackPatch = Partial<Pick<TimelineTrack, 'name' | 'muted' | 'hidden' | 'locked'>>;

export function updateTrack(timeline: Timeline, trackId: string, patch: TrackPatch): Timeline {
  const name = patch.name?.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (patch.name !== undefined && !name) throw new TimelineEditError('Enter a name for the track.');
  return { ...timeline, tracks: timeline.tracks.map((track) => (track.id === trackId ? { ...track, ...patch, ...(name ? { name } : {}) } : track)) };
}

/** Finds (or creates) a track of a compatible kind with room at [startMs, startMs + duration). */
function trackWithRoom(timeline: Timeline, kinds: TrackKind[], startMs: number, duration: number, preferredId?: string): { timeline: Timeline; track: TimelineTrack } {
  const preferred = preferredId ? timeline.tracks.find((track) => track.id === preferredId) : undefined;
  const candidates = [...(preferred ? [preferred] : []), ...timeline.tracks.filter((track) => kinds.includes(track.kind))];
  for (const track of candidates) {
    if (kinds.includes(track.kind) && !track.locked && !overlaps(track.clips, startMs, startMs + duration)) return { timeline, track };
  }
  const added = addTrack(timeline, kinds[0]!);
  return { timeline: added.timeline, track: added.timeline.tracks.find((track) => track.id === added.trackId)! };
}

/** Places a whole asset at `atMs`, on a free compatible track (a new one if needed). */
export function addMediaClip(
  timeline: Timeline,
  asset: Pick<MediaAsset, 'id' | 'kind' | 'durationMs' | 'pageCount'>,
  atMs: number,
  trackId?: string,
  options: { page?: number; durationMs?: number } = {},
): { timeline: Timeline; clipId: string } {
  const kinds = trackKindsFor(asset);
  if (kinds.length === 0) throw new TimelineEditError('This file type can’t be placed on the timeline.');
  const duration = hasFixedLength(asset) ? (asset.durationMs ?? 0) : Math.max(MIN_CLIP_MS, round(options.durationMs ?? DEFAULT_STILL_MS));
  if (duration < MIN_CLIP_MS) throw new TimelineEditError('This media is too short or its length is unknown.');
  const page = asset.kind === 'pdf' ? (options.page ?? 1) : undefined;
  if (page !== undefined && (page < 1 || page > (asset.pageCount ?? 1))) throw new TimelineEditError(`This PDF has no page ${page}.`);
  const startMs = Math.max(0, round(atMs));
  const placed = trackWithRoom(timeline, kinds, startMs, duration, trackId);
  const clip: MediaClip = { id: createId('clp'), type: 'media', assetId: asset.id, startMs, sourceInMs: 0, sourceOutMs: round(duration), ...(page ? { page } : {}) };
  const tracks = replaceTrack(placed.timeline.tracks, placed.track.id, { ...placed.track, clips: sortClips([...placed.track.clips, clip]) });
  return { timeline: finish(placed.timeline, tracks), clipId: clip.id };
}

/**
 * Places PDF pages one after another from `atMs`, each shown for `pageMs`, on one video track with
 * room for all of them (a new track if needed). Pages are 1-based, in the order given.
 */
export function addPdfPages(
  timeline: Timeline,
  asset: Pick<MediaAsset, 'id' | 'kind' | 'pageCount'>,
  pages: readonly number[],
  atMs: number,
  pageMs = DEFAULT_STILL_MS,
  trackId?: string,
): { timeline: Timeline; clipIds: string[] } {
  if (asset.kind !== 'pdf') throw new TimelineEditError('Only PDF pages can be added this way.');
  if (pages.length === 0) throw new TimelineEditError('Select at least one page.');
  const each = Math.max(MIN_CLIP_MS, round(pageMs));
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 1 || page > (asset.pageCount ?? 0)) throw new TimelineEditError(`This PDF has no page ${page}.`);
  }
  const startMs = Math.max(0, round(atMs));
  const placed = trackWithRoom(timeline, ['video'], startMs, each * pages.length, trackId);
  const clips: MediaClip[] = pages.map((page, index) => ({
    id: createId('clp'),
    type: 'media',
    assetId: asset.id,
    startMs: startMs + index * each,
    sourceInMs: 0,
    sourceOutMs: each,
    page,
  }));
  const tracks = replaceTrack(placed.timeline.tracks, placed.track.id, { ...placed.track, clips: sortClips([...placed.track.clips, ...clips]) });
  return { timeline: finish(placed.timeline, tracks), clipIds: clips.map((clip) => clip.id) };
}

export const DEFAULT_TEXT_STYLE: TextStyle = { size: 'medium', color: '#ffffff', background: true };

/** Adds a text annotation at `atMs` (lower third by default) on a free text track. */
export function addTextClip(timeline: Timeline, atMs: number, text = 'Your text'): { timeline: Timeline; clipId: string } {
  const startMs = Math.max(0, round(atMs));
  const placed = trackWithRoom(timeline, ['text'], startMs, DEFAULT_STILL_MS / 2);
  const clip: TextClip = {
    id: createId('clp'),
    type: 'text',
    startMs,
    durationMs: DEFAULT_STILL_MS / 2,
    text,
    position: { x: 0.5, y: 0.85 },
    style: { ...DEFAULT_TEXT_STYLE },
  };
  const tracks = replaceTrack(placed.timeline.tracks, placed.track.id, { ...placed.track, clips: sortClips([...placed.track.clips, clip]) });
  return { timeline: finish(placed.timeline, tracks), clipId: clip.id };
}

export type TextPatch = Partial<{ text: string; position: NormalizedPoint; style: Partial<TextStyle> }>;
export type MediaPatch = Partial<Pick<MediaClip, 'muted' | 'volume'>>;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function updateTextClip(timeline: Timeline, clipId: string, patch: TextPatch): Timeline {
  const { track, clip } = requireClip(timeline, clipId);
  if (clip.type !== 'text') throw new TimelineEditError('Only text items have text.');
  const text = patch.text === undefined ? clip.text : patch.text.slice(0, 300);
  const updated: TextClip = {
    ...clip,
    text,
    position: patch.position ? { x: clamp01(patch.position.x), y: clamp01(patch.position.y) } : clip.position,
    style: { ...clip.style, ...patch.style },
  };
  return { ...timeline, tracks: replaceTrack(timeline.tracks, track.id, { ...track, clips: track.clips.map((c) => (c.id === clipId ? updated : c)) }) };
}

export function updateMediaClip(timeline: Timeline, clipId: string, patch: MediaPatch): Timeline {
  const { track, clip } = requireClip(timeline, clipId);
  if (clip.type !== 'media') throw new TimelineEditError('Only media clips have sound settings.');
  const updated: MediaClip = { ...clip, ...patch, volume: patch.volume === undefined ? clip.volume : clamp01(patch.volume) };
  return { ...timeline, tracks: replaceTrack(timeline.tracks, track.id, { ...track, clips: track.clips.map((c) => (c.id === clipId ? updated : c)) }) };
}

/** Sets a clip's timeline start and length directly (properties panel); clamped like a trim. */
export function setClipTiming(timeline: Timeline, clipId: string, timing: { startMs?: number; durationMs?: number }, assets: AssetLookup): Timeline {
  let current = timeline;
  const found = requireClip(current, clipId);
  if (timing.startMs !== undefined && timing.startMs !== found.clip.startMs) {
    current = moveClip(current, clipId, { startMs: timing.startMs }, assets);
  }
  if (timing.durationMs !== undefined) {
    const clip = findClip(current, clipId)!.clip;
    current = trimClip(current, clipId, 'end', clip.startMs + timing.durationMs, assets);
  }
  return current;
}

/** Where a zoom effect sits on the timeline (for snapping and hit-testing). */
export function markerBounds(marker: Timeline['zoomMarkers'][number]) {
  return markerSpan(marker);
}
