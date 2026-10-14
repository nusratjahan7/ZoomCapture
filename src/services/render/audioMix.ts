/**
 * The audio mix (Module 08): each clip's loudness at a moment is its own volume, its track's
 * volume (the separate microphone / captured audio / music controls) and its fades. The preview
 * sets media elements to it every frame; the export turns the same values into gain automation,
 * so both sound alike.
 */
import { clipDuration, isMediaClip, isStill } from '@/services/timeline/model';
import type { MediaAsset, MediaClip, Timeline, TimelineTrack } from '@/types';

export const MAX_FADE_MS = 30_000;

/** Fade multiplier (0-1) of a clip at a timeline time: rising over `fadeInMs`, falling over `fadeOutMs`. */
export function fadeGain(clip: Pick<MediaClip, 'startMs' | 'sourceInMs' | 'sourceOutMs' | 'fadeInMs' | 'fadeOutMs'>, timeMs: number): number {
  const duration = clip.sourceOutMs - clip.sourceInMs;
  const into = timeMs - clip.startMs;
  if (into < 0 || into > duration) return 0;
  // Fades longer than half the clip each are shortened so they never overlap.
  const fadeIn = Math.min(Math.max(0, clip.fadeInMs ?? 0), duration / 2);
  const fadeOut = Math.min(Math.max(0, clip.fadeOutMs ?? 0), duration / 2);
  let gain = 1;
  if (fadeIn > 0 && into < fadeIn) gain = Math.min(gain, into / fadeIn);
  if (fadeOut > 0 && duration - into < fadeOut) gain = Math.min(gain, (duration - into) / fadeOut);
  return Math.max(0, Math.min(1, gain));
}

/** Loudness (0-1) of a clip at a timeline time, on its track. */
export function clipGain(clip: MediaClip, track: Pick<TimelineTrack, 'muted' | 'volume'>, timeMs: number): number {
  if (clip.muted || track.muted) return 0;
  const volume = Math.min(1, Math.max(0, clip.volume ?? 1)) * Math.min(1, Math.max(0, track.volume ?? 1));
  return volume * fadeGain(clip, timeMs);
}

/**
 * Gain automation for a clip in one mixing window: [seconds into the window, gain] at the points
 * where the gain changes direction (start, end of fade-in, start of fade-out, end), clipped to the
 * window. Straight lines between them reproduce `clipGain` exactly.
 */
export function gainPoints(clip: MediaClip, track: Pick<TimelineTrack, 'muted' | 'volume'>, windowStart: number, windowEnd: number): Array<[number, number]> {
  const start = clip.startMs;
  const end = start + clipDuration(clip);
  const duration = end - start;
  const fadeIn = Math.min(Math.max(0, clip.fadeInMs ?? 0), duration / 2);
  const fadeOut = Math.min(Math.max(0, clip.fadeOutMs ?? 0), duration / 2);
  const from = Math.max(start, windowStart * 1000);
  const to = Math.min(end, windowEnd * 1000);
  if (to <= from) return [];
  const times = new Set([from, to]);
  for (const time of [start + fadeIn, end - fadeOut]) if (time > from && time < to) times.add(time);
  // A point a hair inside the end, so the last segment ends at the clip's real level.
  return [...times]
    .sort((a, b) => a - b)
    .map((time) => [(time - windowStart * 1000) / 1000, clipGain(clip, track, Math.min(time, end - 0.001))]);
}

/** Media clips whose sound is heard, with their asset (skips muted tracks and clips, images, silent media). */
export function audibleClips(timeline: Timeline, assets: ReadonlyMap<string, MediaAsset>): Array<{ clip: MediaClip; asset: MediaAsset; track: TimelineTrack }> {
  const result: Array<{ clip: MediaClip; asset: MediaAsset; track: TimelineTrack }> = [];
  for (const track of timeline.tracks) {
    if (track.muted || (track.volume ?? 1) <= 0 || !(track.kind === 'video' || track.kind === 'audio' || track.kind === 'music')) continue;
    for (const clip of track.clips) {
      if (!isMediaClip(clip) || clip.muted || (clip.volume ?? 1) <= 0) continue;
      const asset = assets.get(clip.assetId);
      if (!asset || isStill(asset) || asset.hasAudio === false) continue;
      result.push({ clip, asset, track });
    }
  }
  return result;
}
