import type { AspectRatio, CameraLayout, ExportResolution } from './project';
import type { CaptureSource } from './session';
import type { AutoZoomSettings } from './zoom';

export type CaptureResolution = 'native' | '1080p' | '1440p' | '2160p';
export type CaptureFrameRate = 30 | 60;
export type CountdownSeconds = 0 | 3 | 5;

export interface UserSettings {
  defaultSource: CaptureSource;
  cameraEnabled: boolean;
  microphoneEnabled: boolean;
  /** Ask Chrome to include tab/system audio with the display stream. */
  captureSystemAudio: boolean;
  resolution: CaptureResolution;
  frameRate: CaptureFrameRate;
  /** Empty string means "system default device". */
  cameraDeviceId: string;
  microphoneDeviceId: string;
  countdownSeconds: CountdownSeconds;
  /** Open an always-on-top Picture-in-Picture window with the camera bubble and controls. */
  floatingControls: boolean;
  /**
   * When recording the entire screen, close the floating window as recording starts so it never
   * appears in the video (it shows only during the countdown). Tab and window captures don't
   * include it, so it stays open for them.
   */
  hideFloatingWhileRecording: boolean;
  /**
   * Windows: during entire-screen recordings, show the controls in the native helper's window,
   * which Windows leaves out of screen captures (needs the helper and `nativeMessaging`).
   */
  nativeControls: boolean;
  /** Last camera bubble placement; copied into each new project. */
  cameraBubble: CameraLayout;
  autoZoom: AutoZoomSettings;
  /** Export size, shape and format given to each new project (changeable per project). */
  projectDefaults: { exportResolution: ExportResolution; aspectRatio: AspectRatio; exportFormat: 'mp4' | 'webm' };
}

export const DEFAULT_SETTINGS: UserSettings = {
  defaultSource: 'screen',
  cameraEnabled: false,
  microphoneEnabled: true,
  captureSystemAudio: true,
  resolution: '1080p',
  frameRate: 30,
  cameraDeviceId: '',
  microphoneDeviceId: '',
  countdownSeconds: 3,
  floatingControls: true,
  hideFloatingWhileRecording: true,
  nativeControls: false,
  cameraBubble: { x: 0.86, y: 0.78, size: 'medium' },
  autoZoom: { enabled: true, trackClicks: true, scale: 2, durationMs: 2500, transitionSpeed: 'normal' },
  projectDefaults: { exportResolution: 'source', aspectRatio: 'source', exportFormat: 'mp4' },
};
