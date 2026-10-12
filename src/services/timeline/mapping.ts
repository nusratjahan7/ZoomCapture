import type { CursorSample, InteractionEvent, MediaClip, Timeline } from '@/types';
import { isMediaClip } from './model';

/**
 * Clicks and pointer samples are recorded in source time of the screen recording. After the
 * screen clip is trimmed, split or moved, they must be shown where that source moment now plays
 * on the timeline (and not at all if it was cut out). These helpers do that mapping, so zoom
 * overlays (click rings, cursor highlight, follow-cursor) stay on the right content.
 */

/** Clips of one asset on visible video tracks, in timeline order. */
export function clipsOfAsset(timeline: Timeline, assetId: string): MediaClip[] {
  return timeline.tracks
    .filter((track) => track.kind === 'video' && !track.hidden)
    .flatMap((track) => track.clips.filter(isMediaClip).filter((clip) => clip.assetId === assetId))
    .sort((a, b) => a.startMs - b.startMs);
}

/** Every timeline time at which a source time of the asset is shown (none if cut). */
export function timelineTimesOf(clips: readonly MediaClip[], sourceMs: number): number[] {
  const times: number[] = [];
  for (const clip of clips) {
    if (sourceMs >= clip.sourceInMs && sourceMs < clip.sourceOutMs) times.push(clip.startMs + (sourceMs - clip.sourceInMs));
  }
  return times;
}

export function mapClicksToTimeline(clips: readonly MediaClip[], clicks: readonly InteractionEvent[]): InteractionEvent[] {
  const mapped: InteractionEvent[] = [];
  for (const click of clicks) {
    timelineTimesOf(clips, click.timeMs).forEach((timeMs, copy) => mapped.push({ ...click, id: copy ? `${click.id}~${copy}` : click.id, timeMs }));
  }
  return mapped.sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Pointer path on the timeline. Each clip contributes its section of the path; a `hidden` sample is
 * inserted at every clip end so the pointer does not appear to glide across a cut.
 */
export function mapCursorToTimeline(clips: readonly MediaClip[], samples: readonly CursorSample[]): CursorSample[] {
  const mapped: CursorSample[] = [];
  for (const clip of clips) {
    let last: CursorSample | null = null;
    for (const sample of samples) {
      if (sample.timeMs < clip.sourceInMs) {
        last = sample;
        continue;
      }
      if (sample.timeMs >= clip.sourceOutMs) break;
      // The pointer position at the in-point is the last sample before it.
      if (last && mapped.at(-1)?.timeMs !== clip.startMs) mapped.push({ ...last, timeMs: clip.startMs });
      last = null;
      mapped.push({ ...sample, timeMs: clip.startMs + (sample.timeMs - clip.sourceInMs) });
    }
    if (last) mapped.push({ ...last, timeMs: clip.startMs });
    mapped.push({ timeMs: clip.startMs + (clip.sourceOutMs - clip.sourceInMs), x: 0, y: 0, hidden: true });
  }
  return mapped.sort((a, b) => a.timeMs - b.timeMs);
}
