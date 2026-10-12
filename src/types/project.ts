/**
 * Storage model.
 *
 * - `Recording` (types/recording.ts) is what was captured: its name, its original media and facts
 *   about it. The original media is never modified after saving.
 * - `Project` is the editable layer on top of one recording: timeline, zoom effects, camera
 *   placement, subtitles, music, imported assets and export settings. Editing never touches the
 *   original recording, so a project can always be reset.
 * - `MediaAsset` describes one stored Blob (the bytes live in the `assetBlobs` store).
 *
 * All times are in milliseconds relative to the start of the timeline.
 */
import type { SelectedSurface } from './session';

export type MediaAssetKind =
  | 'screen'
  | 'camera'
  | 'microphone'
  | 'system-audio'
  | 'thumbnail'
  /** Imported by the user into a project (future modules). */
  | 'image'
  | 'audio'
  | 'video';

/** `recording`: original captured media. `generated`: derived (thumbnail). `import`: added to a project. */
export type MediaAssetOrigin = 'recording' | 'generated' | 'import';

export interface MediaAsset {
  id: string;
  kind: MediaAssetKind;
  origin: MediaAssetOrigin;
  /** Owner of original and generated media. */
  recordingId?: string;
  /** Owner of imported media. */
  projectId?: string;
  mimeType: string;
  /** Size of the stored blob in bytes. */
  size: number;
  durationMs?: number;
  /** Where this asset starts relative to the start of the recording, in recorded (unpaused) time. */
  startOffsetMs: number;
  width?: number;
  height?: number;
  /** Device or surface name, e.g. "FaceTime HD Camera", or the imported file name. */
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

/** Project-wide zoom behaviour. Individual effects are `Timeline.zoomMarkers`. */
export interface ZoomSettings {
  mode: 'auto' | 'manual' | 'off';
  defaultScale: number;
  easing: ZoomEasing;
}

/** A captured interaction used to generate automatic zoom markers. */
export interface InteractionEvent {
  timeMs: number;
  type: 'click' | 'keypress' | 'scroll' | 'cursor';
  /** Normalised (0-1) position in the source frame. */
  x: number;
  y: number;
}

/** `music` tracks hold imported audio assets. */
export type TrackKind = 'video' | 'camera' | 'audio' | 'music';

export interface TimelineClip {
  id: string;
  assetId: string;
  /** Position of the clip on the timeline. */
  startMs: number;
  /** Trim window within the source asset. */
  sourceInMs: number;
  sourceOutMs: number;
  muted?: boolean;
  /** 0-1. */
  volume?: number;
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

export interface SubtitleCue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface SubtitleTrack {
  id: string;
  label: string;
  /** BCP 47 language tag, e.g. "en". */
  language: string;
  cues: SubtitleCue[];
}

export type ExportFormat = 'webm' | 'mp4' | 'gif';

export interface ExportSettings {
  format: ExportFormat;
  resolution: 'source' | '720p' | '1080p' | '1440p' | '2160p';
  frameRate: 30 | 60;
  quality: 'standard' | 'high';
  includeCamera: boolean;
  burnInSubtitles: boolean;
}

/** Bump when the Project shape changes; `services/storage/migrations.ts` upgrades older data. */
export const PROJECT_SCHEMA_VERSION = 1;

export interface Project {
  id: string;
  /** The original recording this project edits. */
  recordingId: string;
  schemaVersion: number;
  timeline: Timeline;
  zoom: ZoomSettings;
  interactions: InteractionEvent[];
  cameraLayout?: CameraLayout;
  subtitles: SubtitleTrack[];
  /** Assets the user imported into this project (images, music, video); `MediaAsset.projectId` = this id. */
  importedAssetIds: string[];
  exportSettings: ExportSettings;
  createdAt: number;
  updatedAt: number;
}

/** What was captured, as reported by Chrome's picker. */
export interface CaptureSourceInfo {
  surface: SelectedSurface['surface'];
  label: string;
}
