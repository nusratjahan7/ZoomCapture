/** What the user asked to capture. Maps to the `displaySurface` hint of getDisplayMedia(). */
export type CaptureSource = 'screen' | 'window' | 'tab';

/**
 * Lifecycle of a recording session. The background service worker is the only writer and
 * enforces the transitions in `SESSION_TRANSITIONS`. Module 01 drives `preparing`,
 * `source-ready`, `cancelled` and `error`; the capture states are used by the recording
 * engine in later modules.
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
  countdown: ['recording', 'source-ready', 'cancelled', 'error'],
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

export interface RecordingSession {
  id: string;
  status: SessionStatus;
  options: CaptureOptions;
  /** Tab hosting the recording page that owns the media streams. */
  recordingTabId?: number;
  selectedSurface?: SelectedSurface;
  /** Project created from this session once recording completes. */
  projectId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
