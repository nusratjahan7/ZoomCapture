import type { CameraLayout } from './project';
import type { CaptureSource } from './session';

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
  /** Last camera bubble placement; copied into each new project. */
  cameraBubble: CameraLayout;
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
  cameraBubble: { x: 0.86, y: 0.78, size: 'medium' },
};
