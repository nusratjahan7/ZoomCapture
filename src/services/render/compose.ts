import { clipAt } from '@/services/timeline/model';
import { clipsOfAsset, mapClicksToTimeline, mapCursorToTimeline } from '@/services/timeline/mapping';
import type { Size } from '@/services/zoom/coordinates';
import type { AspectRatio, ExportSettings, MediaClip, Project, Recording, TextClip, Timeline, TimelineTrack } from '@/types';
import { renderEffectsOf, type RenderScene } from './frameState';
import { RESOLUTION_HEIGHT } from './output';

/**
 * Timeline composition: what is visible at a timeline time, and the shape of the output frame.
 * Pure functions, shared by the editor preview and the rendered video.
 */

export interface ActiveMedia {
  track: TimelineTrack;
  clip: MediaClip;
  /** Source time of the clip's asset to show, in ms. */
  sourceMs: number;
}

export interface ActiveVisuals {
  /** Video-track clips, bottom layer first (zoom applies to these). */
  layers: ActiveMedia[];
  /** The top-most camera clip (drawn as the bubble). */
  camera: ActiveMedia | null;
  /** Text annotations, bottom layer first. */
  texts: TextClip[];
}

export function activeVisuals(timeline: Timeline, timeMs: number): ActiveVisuals {
  const result: ActiveVisuals = { layers: [], camera: null, texts: [] };
  // Tracks are listed top layer first; compose from the bottom up.
  for (let index = timeline.tracks.length - 1; index >= 0; index--) {
    const track = timeline.tracks[index]!;
    if (track.hidden) continue;
    const clip = clipAt(track, timeMs);
    if (!clip) continue;
    if (clip.type === 'text') {
      if (track.kind === 'text') result.texts.push(clip);
      continue;
    }
    const active = { track, clip, sourceMs: clip.sourceInMs + (timeMs - clip.startMs) };
    if (track.kind === 'video') result.layers.push(active);
    else if (track.kind === 'camera') result.camera = active;
  }
  return result;
}

/**
 * Zoom scene for a timeline: markers are in timeline time already; clicks and the pointer path are
 * recorded in source time of the screen recording and are mapped through its clips.
 */
export function timelineScene(project: Pick<Project, 'timeline' | 'renderEffects'>, recording: Pick<Recording, 'screenAssetId' | 'interactions' | 'cursor'>): Omit<RenderScene, 'zoom'> {
  const clips = clipsOfAsset(project.timeline, recording.screenAssetId);
  return {
    markers: project.timeline.zoomMarkers,
    clicks: mapClicksToTimeline(clips, recording.interactions),
    cursor: mapCursorToTimeline(clips, recording.cursor ?? []),
    effects: renderEffectsOf(project),
  };
}

const RATIOS: Record<Exclude<AspectRatio, 'source'>, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3 };

/** Width / height of the output for an aspect setting. */
export function aspectValue(aspect: AspectRatio, source: Size): number {
  return aspect === 'source' ? source.width / source.height : RATIOS[aspect];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The recording's picture inside an output frame: as large as possible, centred (letterboxed). */
export function contentRect(output: Size, source: Size): Rect {
  const scale = Math.min(output.width / source.width, output.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return { x: (output.width - width) / 2, y: (output.height - height) / 2, width, height };
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/**
 * Output frame size for an aspect ratio and resolution. The resolution names the short side
 * (1080p → 1920×1080 landscape, 1080×1920 portrait), never larger than the recording's short side.
 */
export function frameSize(source: Size, aspect: AspectRatio, resolution: ExportSettings['resolution']): Size {
  const ratio = aspectValue(aspect, source);
  const sourceShort = Math.min(source.width, source.height);
  const short = resolution === 'source' ? sourceShort : Math.min(RESOLUTION_HEIGHT[resolution], sourceShort);
  return ratio >= 1 ? { width: even(short * ratio), height: even(short) } : { width: even(short), height: even(short / ratio) };
}
