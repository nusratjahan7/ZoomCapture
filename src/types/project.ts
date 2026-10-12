/**
 * Persistent editing model. A project owns media assets (stored as blobs in IndexedDB),
 * zoom markers and an editable timeline. All times are in milliseconds relative to the
 * start of the project timeline.
 */

export type MediaAssetKind = 'screen' | 'camera' | 'microphone' | 'system-audio' | 'image';

export interface MediaAsset {
  id: string;
  projectId: string;
  kind: MediaAssetKind;
  mimeType: string;
  /** Size of the stored blob in bytes. */
  size: number;
  durationMs?: number;
  width?: number;
  height?: number;
  createdAt: number;
}

export type ZoomEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'spring';

/** A zoom effect applied over a time range of the timeline. */
export interface ZoomMarker {
  id: string;
  startMs: number;
  endMs: number;
  /** Scale factor (1 = no zoom). */
  scale: number;
  /** Focus point in normalised (0-1) coordinates of the source frame. */
  focus: { x: number; y: number };
  easing: ZoomEasing;
  /** `auto` markers are generated from captured interaction events; `manual` are user-authored. */
  origin: 'auto' | 'manual';
}

/** A captured interaction used to generate automatic zoom markers. */
export interface InteractionEvent {
  timeMs: number;
  type: 'click' | 'keypress' | 'scroll' | 'cursor';
  /** Normalised (0-1) position in the source frame. */
  x: number;
  y: number;
}

export type TrackKind = 'video' | 'camera' | 'audio';

export interface TimelineClip {
  id: string;
  assetId: string;
  /** Position of the clip on the timeline. */
  startMs: number;
  /** Trim window within the source asset. */
  sourceInMs: number;
  sourceOutMs: number;
  muted?: boolean;
}

export interface TimelineTrack {
  id: string;
  kind: TrackKind;
  name: string;
  clips: TimelineClip[];
  locked?: boolean;
  hidden?: boolean;
}

export interface Timeline {
  durationMs: number;
  tracks: TimelineTrack[];
  zoomMarkers: ZoomMarker[];
}

export interface Project {
  id: string;
  name: string;
  /** Recording session that produced this project, if any. */
  sessionId?: string;
  timeline: Timeline;
  interactions: InteractionEvent[];
  createdAt: number;
  updatedAt: number;
}

/** Lightweight projection used by lists (popup, library). */
export interface ProjectSummary {
  id: string;
  name: string;
  durationMs: number;
  createdAt: number;
  updatedAt: number;
}
