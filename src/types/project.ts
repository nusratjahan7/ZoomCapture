/**
 * Storage model.
 *
 * - `Recording` (types/recording.ts) is what was captured: its name, its original media and facts
 *   about it. The original media is never modified after saving.
 * - `Project` is the editable layer on top of one recording: timeline, zoom markers, camera
 *   placement, subtitles, music, imported assets and export settings. Editing never touches the
 *   original recording, so a project can always be reset.
 * - `MediaAsset` describes one stored Blob (the bytes live in the `assetBlobs` store).
 *
 * All times are in milliseconds relative to the start of the timeline.
 */
import type { SelectedSurface } from './session';
import type { NormalizedPoint, RenderEffects, ZoomMarker, ZoomSettings } from './zoom';

export type MediaAssetKind =
  | 'screen'
  | 'camera'
  | 'microphone'
  | 'system-audio'
  | 'thumbnail'
  /** Imported by the user into a project. */
  | 'image'
  | 'audio'
  | 'video'
  /** A PDF document; each page can be placed on the timeline (Module 07). */
  | 'pdf';

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
  /** PDF documents: number of pages. */
  pageCount?: number;
  /**
   * Imports: size, modification time and a hash of the first and last megabyte, so importing the
   * same file twice reuses the stored copy instead of storing it again.
   */
  fingerprint?: string;
  /** Imports recorded in the editor (voiceover narration). */
  voiceover?: boolean;
  createdAt: number;
}

export type CameraBubbleSize = 'small' | 'medium' | 'large';

/** Bubble diameter as a fraction of the frame width. */
export const CAMERA_BUBBLE_SCALE: Record<CameraBubbleSize, number> = { small: 0.14, medium: 0.2, large: 0.28 };

/** Smallest and largest bubble diameter (fraction of the frame width) when resized freely. */
export const CAMERA_BUBBLE_LIMITS = { min: 0.08, max: 0.4 } as const;

/** Placement of the camera bubble over the screen video. `x`/`y` is its centre, normalised 0-1. */
export interface CameraLayout {
  x: number;
  y: number;
  /** Preset size; used when `scale` is not set. */
  size: CameraBubbleSize;
  /** Diameter as a fraction of the frame width, set by resizing the bubble. Overrides `size`. */
  scale?: number;
}

/** The bubble's diameter as a fraction of the frame width. */
export function cameraBubbleScale(layout: CameraLayout): number {
  const scale = layout.scale ?? CAMERA_BUBBLE_SCALE[layout.size];
  return Math.min(CAMERA_BUBBLE_LIMITS.max, Math.max(CAMERA_BUBBLE_LIMITS.min, Number.isFinite(scale) ? scale : CAMERA_BUBBLE_SCALE.medium));
}

/**
 * Timeline model. One time unit everywhere: integer milliseconds.
 *
 * - Timeline positions (`startMs`) say where an item plays in the edited video.
 * - Source times (`sourceInMs`/`sourceOutMs`) say which part of the asset it shows. They are kept
 *   separate, so moving a clip changes only `startMs` and trimming changes both consistently.
 * - Layer order is the order of `Timeline.tracks`: the first track is drawn on top.
 */

/**
 * `video`: screen recording, imported video and images (zoom effects apply to these layers).
 * `camera`: the camera bubble. `audio`: recorded audio stems. `music`: imported audio.
 * `text`: text annotations.
 */
export type TrackKind = 'video' | 'camera' | 'audio' | 'music' | 'text';

/** A section of a media asset placed on the timeline. Its duration is `sourceOutMs − sourceInMs`. */
export interface MediaClip {
  id: string;
  type: 'media';
  assetId: string;
  /** Position of the clip on the timeline. */
  startMs: number;
  /** Trim window within the source asset (source time, independent of the timeline position). */
  sourceInMs: number;
  sourceOutMs: number;
  muted?: boolean;
  /** 0-1. */
  volume?: number;
  /** PDF assets: the page shown (1-based). Like an image, a page can be shown for any length. */
  page?: number;
}

export type TextSize = 'small' | 'medium' | 'large';

export interface TextStyle {
  size: TextSize;
  /** CSS colour of the text. */
  color: string;
  /** Draw a dark box behind the text for legibility. */
  background: boolean;
}

/** A text annotation shown over the video. */
export interface TextClip {
  id: string;
  type: 'text';
  startMs: number;
  durationMs: number;
  text: string;
  /** Centre of the text, normalised to the output frame. */
  position: NormalizedPoint;
  style: TextStyle;
}

export type TimelineClip = MediaClip | TextClip;

export interface TimelineTrack {
  id: string;
  kind: TrackKind;
  name: string;
  /** Sorted by `startMs`; clips on one track never overlap. */
  clips: TimelineClip[];
  locked?: boolean;
  /** Hidden visual tracks are not drawn. */
  hidden?: boolean;
  /** Muted tracks are silent. */
  muted?: boolean;
}

export interface Timeline {
  /** End of the last clip. */
  durationMs: number;
  /** Top layer first. */
  tracks: TimelineTrack[];
  /** Zoom effects: editable, stored with the project, never in the original recording. */
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

/** Shape of the rendered video. `source` keeps the recording's own shape. */
export type AspectRatio = 'source' | '16:9' | '9:16' | '1:1' | '4:3';

/** Bump when the Project shape changes; `services/storage/migrations.ts` upgrades older data. */
export const PROJECT_SCHEMA_VERSION = 3;

export interface Project {
  id: string;
  /** The original recording this project edits. */
  recordingId: string;
  schemaVersion: number;
  timeline: Timeline;
  zoom: ZoomSettings;
  cameraLayout?: CameraLayout;
  aspectRatio: AspectRatio;
  /** Cursor and click overlays; absent in older projects (see `renderEffectsOf`). */
  renderEffects?: RenderEffects;
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
