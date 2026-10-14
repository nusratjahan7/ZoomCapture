import type { MediaAsset, MediaAssetKind, MediaClip, TextClip, Timeline, TimelineClip, TimelineTrack, TrackKind } from '@/types';

/**
 * Read-only helpers over the timeline model (types/project.ts). All times are milliseconds:
 * timeline positions (`startMs`) and source times (`sourceInMs`/`sourceOutMs`) never mix except
 * through `sourceTimeAt` / `timelineTimeOf`.
 */

/** Shortest clip that can be created by trimming or splitting. */
export const MIN_CLIP_MS = 100;
/** Default length of an image or text clip when added. */
export const DEFAULT_STILL_MS = 5000;

export const isMediaClip = (clip: TimelineClip): clip is MediaClip => clip.type === 'media';
export const isTextClip = (clip: TimelineClip): clip is TextClip => clip.type === 'text';

export function clipDuration(clip: TimelineClip): number {
  return clip.type === 'media' ? clip.sourceOutMs - clip.sourceInMs : clip.durationMs;
}

export function clipEnd(clip: TimelineClip): number {
  return clip.startMs + clipDuration(clip);
}

/** End of the last clip on any track. */
export function contentDuration(tracks: readonly TimelineTrack[]): number {
  let end = 0;
  for (const track of tracks) for (const clip of track.clips) end = Math.max(end, clipEnd(clip));
  return end;
}

/** The clip playing on a track at `timeMs` (start inclusive, end exclusive). */
export function clipAt(track: TimelineTrack, timeMs: number): TimelineClip | null {
  for (const clip of track.clips) {
    if (timeMs >= clip.startMs && timeMs < clipEnd(clip)) return clip;
    if (clip.startMs > timeMs) break;
  }
  return null;
}

/** Source time shown by a media clip at a timeline time. */
export function sourceTimeAt(clip: MediaClip, timeMs: number): number {
  return clip.sourceInMs + (timeMs - clip.startMs);
}

export function findClip(timeline: Timeline, clipId: string): { track: TimelineTrack; clip: TimelineClip; index: number } | null {
  for (const track of timeline.tracks) {
    const index = track.clips.findIndex((clip) => clip.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  return null;
}

/** Which tracks may hold which assets. */
const TRACK_FOR_ASSET: Partial<Record<MediaAssetKind, TrackKind[]>> = {
  screen: ['video'],
  video: ['video'],
  image: ['video'],
  pdf: ['video'],
  camera: ['camera'],
  microphone: ['audio', 'music'],
  'system-audio': ['audio', 'music'],
  audio: ['music', 'audio'],
};

/** Track kinds an asset can be placed on (the first is the default); empty if it can't be placed. */
export function trackKindsFor(asset: Pick<MediaAsset, 'kind'>): TrackKind[] {
  return TRACK_FOR_ASSET[asset.kind] ?? [];
}

export function acceptsClip(track: TimelineTrack, clip: TimelineClip, assetKind?: MediaAssetKind): boolean {
  if (clip.type === 'text') return track.kind === 'text';
  return assetKind !== undefined && trackKindsFor({ kind: assetKind }).includes(track.kind);
}

/** Stills (images and PDF pages) can be shown for any length; videos and audio have their own. */
export function isStill(asset: Pick<MediaAsset, 'kind'>): boolean {
  return asset.kind === 'image' || asset.kind === 'pdf';
}

/** Whether an asset has a fixed length (videos and audio) or can be shown for any time (stills). */
export function hasFixedLength(asset: Pick<MediaAsset, 'kind'>): boolean {
  return !isStill(asset);
}

export const TRACK_NAMES: Record<TrackKind, string> = {
  video: 'Video',
  camera: 'Camera',
  audio: 'Audio',
  music: 'Music',
  text: 'Text',
};

export const isVisualTrack = (track: Pick<TimelineTrack, 'kind'>) => track.kind === 'video' || track.kind === 'camera' || track.kind === 'text';
export const isAudibleTrack = (track: Pick<TimelineTrack, 'kind'>) => track.kind === 'video' || track.kind === 'audio' || track.kind === 'music';
