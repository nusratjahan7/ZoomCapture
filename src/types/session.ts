/** What the user asked to capture. Maps to the `displaySurface` hint of getDisplayMedia(). */
export type CaptureSource = 'screen' | 'window' | 'tab';

/**
 * Lifecycle of a recording session. The background service worker is the only writer and
 * enforces the transitions in `SESSION_TRANSITIONS`.
 */
export type SessionStatus =
  | 'preparing'
  | 'source-ready'
  | 'countdown'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'completed'
  | 'cancelled'
  | 'error';

export const SESSION_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  preparing: ['source-ready', 'cancelled', 'error'],
  'source-ready': ['preparing', 'countdown', 'recording', 'cancelled', 'error'],
  countdown: ['recording', 'source-ready', 'preparing', 'cancelled', 'error'],
  recording: ['paused', 'finalizing', 'error'],
  paused: ['recording', 'finalizing', 'error'],
  finalizing: ['completed', 'error'],
  completed: [],
  cancelled: [],
  error: [],
};

export const TERMINAL_SESSION_STATUSES: readonly SessionStatus[] = ['completed', 'cancelled', 'error'];

export interface CaptureOptions {
  source: CaptureSource;
  camera: boolean;
  microphone: boolean;
}

/** Description of the surface actually granted by the user in Chrome's picker. */
export interface SelectedSurface {
  /** `displaySurface` reported by the track settings (may differ from the requested source). */
  surface: 'monitor' | 'window' | 'browser' | 'unknown';
  label: string;
  width?: number;
  height?: number;
  frameRate?: number;
  hasAudio: boolean;
}

/**
 * Independently recorded media of a session. Each kind becomes its own MediaAsset:
 * - `screen`: the shared surface video, plus the mixed microphone + tab/system audio, so the file
 *   plays and downloads on its own;
 * - `camera`: camera video only;
 * - `microphone` / `system-audio`: separate audio stems for per-source editing.
 */
export type RecordingTrackKind = 'screen' | 'camera' | 'microphone' | 'system-audio';

export interface RecordingTrackInfo {
  kind: RecordingTrackKind;
  mimeType: string;
  label: string;
}

/** Wall-clock timing used to show the elapsed recording time outside the studio (popup). */
export interface SessionTiming {
  startedAt: number;
  /** Set while paused (or once recording ends), freezing the elapsed time. */
  pausedAt?: number;
  pausedMs: number;
}

export interface RecordingSession {
  id: string;
  status: SessionStatus;
  options: CaptureOptions;
  /** Tab hosting the recording page that owns the media streams. */
  recordingTabId?: number;
  selectedSurface?: SelectedSurface;
  timing?: SessionTiming;
  tracks?: RecordingTrackInfo[];
  /** Recording saved from this session once it completes. */
  recordingId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
