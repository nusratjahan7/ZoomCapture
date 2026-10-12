import type { CaptureResolution, CaptureSource, SelectedSurface, UserSettings } from '@/types';

/** Pre-selects the matching tab in Chrome's share picker. The user can still pick any surface. */
const SURFACE_HINT: Record<CaptureSource, 'monitor' | 'window' | 'browser'> = {
  screen: 'monitor',
  window: 'window',
  tab: 'browser',
};

const RESOLUTION_LIMITS: Record<Exclude<CaptureResolution, 'native'>, [number, number]> = {
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  '2160p': [3840, 2160],
};

type DisplayVideoConstraints = MediaTrackConstraints & { displaySurface?: string };

type DisplayOptions = DisplayMediaStreamOptions & {
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
  systemAudio?: 'include' | 'exclude';
  monitorTypeSurfaces?: 'include' | 'exclude';
};

/**
 * Opens Chrome's native screen-sharing picker. Must be called from a user gesture in a
 * visible extension page (the popup closes when the picker opens, so it cannot host this).
 */
export function requestDisplayStream(
  source: CaptureSource,
  settings: Pick<UserSettings, 'resolution' | 'frameRate' | 'captureSystemAudio'>,
): Promise<MediaStream> {
  const video: DisplayVideoConstraints = {
    displaySurface: SURFACE_HINT[source],
    frameRate: { ideal: settings.frameRate, max: settings.frameRate },
  };
  if (settings.resolution !== 'native') {
    const [width, height] = RESOLUTION_LIMITS[settings.resolution];
    video.width = { max: width };
    video.height = { max: height };
  }

  const options: DisplayOptions = {
    video,
    audio: settings.captureSystemAudio,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: settings.captureSystemAudio ? 'include' : 'exclude',
    monitorTypeSurfaces: 'include',
  };
  return navigator.mediaDevices.getDisplayMedia(options);
}

export function describeDisplayStream(stream: MediaStream): SelectedSurface {
  const track = stream.getVideoTracks()[0];
  const settings = (track?.getSettings() ?? {}) as MediaTrackSettings & { displaySurface?: string };
  const surface = settings.displaySurface;
  // Chrome labels monitors with internal ids such as "screen:2077749241:0".
  const label = surface === 'monitor' && track?.label.startsWith('screen:') ? 'Entire screen' : track?.label;
  return {
    surface: surface === 'monitor' || surface === 'window' || surface === 'browser' ? surface : 'unknown',
    label: label || 'Shared surface',
    width: settings.width,
    height: settings.height,
    frameRate: settings.frameRate ? Math.round(settings.frameRate) : undefined,
    hasAudio: stream.getAudioTracks().length > 0,
  };
}
