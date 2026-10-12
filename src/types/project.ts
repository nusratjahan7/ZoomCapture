/**
 * Persistent editing model. A project owns media assets (stored as blobs in IndexedDB),
 * zoom markers and an editable timeline. All times are in milliseconds relative to the
 * start of the project timeline.
 */
import type { SelectedSurface } from './session';

export type MediaAssetKind = 'screen' | 'camera' | 'microphone' | 'system-audio' | 'image';

export interface MediaAsset {
  id: string;
  projectId: string;
  kind: MediaAssetKind;
  mimeType: string;
  /** Size of the stored blob in bytes. */
  size: number;
  durationMs?: number;
  /** Where this asset starts relative to the start of the recording, in recorded (unpaused) time. */
  startOffsetMs: number;
  width?: number;
  height?: number;
  /** Device or surface name, e.g. "FaceTime HD Camera". */
  label?: string;
  hasAudio?: boolean;
  /** The source stopped before the recording did (device unplugged, tab closed…). */
  endedEarly?: boolean;
  createdAt: number;
}

export type CameraBubbleSize = 'small' | 'medium' | 'large';

/** Bubble diameter as a fraction of the frame width. */
export const CAMERA_BUBBLE_SCALE: Record<CameraBubbleSize, number> = { small: 0.14, medium: 0.2, large: 0.28 };

/** Placement of the camera bubble over the screen video. `x`/`y` is its centre, normalised 0-1. */
export interface CameraLayout {
  x: number;
  y: number;
  size: CameraBubbleSize;
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
  cameraLayout?: CameraLayout;
  /** What was captured. */
  source?: { surface: SelectedSurface['surface']; label: string };
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
