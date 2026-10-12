import type { CameraLayout, CaptureSourceInfo } from './project';
import type { RecordingTrackKind } from './session';
import type { AutoZoomSettings, ClickTrackingInfo, InteractionEvent } from './zoom';

/**
 * A saved recording: the original, immutable capture. Listing recordings reads only these small
 * records; media bytes live in `assetBlobs` and are loaded on demand.
 */
export interface Recording {
  /** `rec_…`, unique; written with `add()` so an id can never overwrite another recording. */
  id: string;
  /** User-editable display name. */
  name: string;
  /** Editable project built on this recording. */
  projectId: string;
  /** Recording session that produced it. */
  sessionId?: string;
  durationMs: number;
  /** Total bytes of the original media (all tracks). */
  sizeBytes: number;
  /** Format of the playable screen file, e.g. "video/webm;codecs=vp9,opus". */
  mimeType: string;
  width?: number;
  height?: number;
  source?: CaptureSourceInfo;
  /** The self-contained playable file (screen video + mixed audio). */
  screenAssetId: string;
  /** Every original media asset (screen, camera, microphone, system audio). */
  assetIds: string[];
  thumbnailAssetId?: string;
  /** Clicks captured during recording (original data; zoom markers derived from them live in the Project). */
  interactions: InteractionEvent[];
  clickTracking: ClickTrackingInfo;
  createdAt: number;
  updatedAt: number;
}

/**
 * A recording in progress, interrupted, or partway through saving, persisted to IndexedDB as it is
 * captured. Media arrives as ~1 s chunks in `recordingChunks`, so a crash loses at most the last
 * second. `finalizeDraft()` turns it into a Recording + Project; it can resume after interruption.
 */
export interface RecordingDraft {
  /** Same as the recording session id. */
  id: string;
  name: string;
  /** Recorded (unpaused) duration so far. */
  durationMs: number;
  tracks: DraftTrack[];
  cameraLayout?: CameraLayout;
  source?: CaptureSourceInfo;
  interactions?: InteractionEvent[];
  clickTracking?: ClickTrackingInfo;
  /** Automatic-zoom preferences at recording time, applied when the recording is saved. */
  autoZoom?: AutoZoomSettings;
  /** Reserved when saving starts, so a resumed save produces the same ids. */
  recordingId?: string;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DraftTrack {
  id: string;
  kind: RecordingTrackKind;
  mimeType: string;
  label: string;
  startOffsetMs: number;
  durationMs: number;
  bytes: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  endedEarly?: boolean;
  /** Set once this track has been converted into a MediaAsset during saving. */
  assetId?: string;
  /** Saving found no data for this track. */
  empty?: boolean;
}

export interface RecordingChunk {
  draftId: string;
  trackId: string;
  seq: number;
  data: Blob;
}

/** Progress of saving a recording, reported by `finalizeDraft()`. */
export interface SaveProgress {
  stage: 'preparing' | 'processing' | 'saving' | 'thumbnail' | 'done';
  /** 0-1 across the whole save. */
  fraction: number;
}
