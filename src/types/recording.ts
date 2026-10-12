import type { CameraLayout, Project } from './project';
import type { RecordingTrackKind } from './session';

/**
 * A recording in progress (or interrupted), persisted to IndexedDB as it is captured.
 * Media arrives as ~1 s chunks in the `recordingChunks` store, so a crash or a closed tab loses
 * at most the last second. `finalizeDraft()` turns a draft into a Project with MediaAssets.
 */
export interface RecordingDraft {
  /** Same as the recording session id. */
  id: string;
  name: string;
  /** Recorded (unpaused) duration so far. */
  durationMs: number;
  tracks: DraftTrack[];
  cameraLayout?: CameraLayout;
  source?: Project['source'];
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
}

export interface RecordingChunk {
  draftId: string;
  trackId: string;
  seq: number;
  data: Blob;
}
