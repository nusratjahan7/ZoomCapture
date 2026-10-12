import type { CaptureSource } from './session';

export type CaptureResolution = 'native' | '1080p' | '1440p' | '2160p';
export type CaptureFrameRate = 30 | 60;

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
};
