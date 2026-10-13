import { updateMarker, type MarkerPatch } from '@/services/zoom/markers';
import type { MediaClip, Timeline, TimelineTrack, ZoomMarker } from '@/types';
import { clipEnd, isMediaClip } from './model';

/**
 * Which clip a zoom effect belongs to (Module 07).
 *
 * A zoom effect zooms into the picture of one video clip: the screen recording for effects made
 * from clicks, or the clip on screen where it was added. That clip is stored on the effect
 * (`ZoomMarker.clipId`) and decides what happens to it:
 *
 * - Moving the clip (in time, or to another video track) moves its effects by the same amount.
 * - Splitting the clip: effects after the cut go with the right-hand part.
 * - Duplicating the clip copies its effects onto the copy.
 * - Deleting the clip deletes its effects (undo brings both back).
 * - Trimming keeps the effects, but an effect only applies while its clip is on screen, so one in
 *   a trimmed-away part does nothing until the trim is undone or widened again.
 * - Moving an effect on the timeline attaches it to the clip on screen at its new time.
 *
 * Effects without a clip (projects from before Module 07) belong to the lowest visible video clip
 * at their time, which is the screen recording in those projects.
 */

const videoTracks = (timeline: Timeline) => timeline.tracks.filter((track) => track.kind === 'video');

function clipAtTime(track: TimelineTrack, timeMs: number): MediaClip | null {
  for (const clip of track.clips) if (isMediaClip(clip) && timeMs >= clip.startMs && timeMs < clipEnd(clip)) return clip;
  return null;
}

/** The clip an effect belongs to, or null (over a gap, or its clip was removed). */
export function markerClipId(timeline: Timeline, marker: Pick<ZoomMarker, 'clipId' | 'timeMs'>): string | null {
  const tracks = videoTracks(timeline);
  if (marker.clipId) return tracks.some((track) => track.clips.some((clip) => clip.id === marker.clipId)) ? marker.clipId : null;
  // Tracks are listed top layer first: the lowest one is last.
  for (let index = tracks.length - 1; index >= 0; index--) {
    const track = tracks[index]!;
    if (track.hidden) continue;
    const clip = clipAtTime(track, marker.timeMs);
    if (clip) return clip.id;
  }
  return null;
}

/** The clip a new effect at `timeMs` zooms into: the topmost visible video clip there. */
export function clipForNewMarker(timeline: Timeline, timeMs: number): string | undefined {
  for (const track of videoTracks(timeline)) {
    if (track.hidden) continue;
    const clip = clipAtTime(track, timeMs);
    if (clip) return clip.id;
  }
  return undefined;
}

/**
 * The effects that apply: those whose clip is on screen at their time (effects over a gap, with no
 * clip, still apply there).
 */
export function activeMarkers(timeline: Timeline): ZoomMarker[] {
  return timeline.zoomMarkers.filter((marker) => {
    if (!marker.clipId) return true;
    for (const track of videoTracks(timeline)) {
      const clip = track.clips.find((candidate) => candidate.id === marker.clipId);
      if (clip) return !track.hidden && marker.timeMs >= clip.startMs && marker.timeMs < clipEnd(clip);
    }
    return false;
  });
}

/** Sets the clip on effects that have none yet (e.g. right after they are made from clicks). */
export function attachMarkers(timeline: Timeline, markers: readonly ZoomMarker[], pick: (marker: ZoomMarker) => string | undefined): ZoomMarker[] {
  return markers.map((marker) => (marker.clipId ? marker : { ...marker, clipId: pick(marker) ?? markerClipId(timeline, marker) ?? undefined }));
}

/** Changes an effect; a new time also attaches it to the clip on screen there. */
export function updateMarkerOnTimeline(timeline: Timeline, markerId: string, patch: MarkerPatch): Timeline {
  let zoomMarkers = updateMarker(timeline.zoomMarkers, markerId, patch, timeline.durationMs);
  if (patch.timeMs !== undefined) {
    zoomMarkers = zoomMarkers.map((marker) => {
      if (marker.id !== markerId) return marker;
      const clipId = clipForNewMarker(timeline, marker.timeMs);
      return clipId ? { ...marker, clipId } : marker;
    });
  }
  return { ...timeline, zoomMarkers };
}
