import type { CaptureResolution, CaptureTarget, UserSettings } from '@/types';

const RESOLUTION_LIMITS: Record<Exclude<CaptureResolution, 'native'>, [number, number]> = {
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  '2160p': [3840, 2160],
};

/** Chrome's legacy constraint format, required for `chromeMediaSource: 'tab'` streams. */
type TabConstraints = MediaTrackConstraints & {
  mandatory: Record<string, string | number>;
};

/**
 * Captures exactly the tab ZoomCapture was opened on, without Chrome's picker. Allowed because
 * the user invoked the extension on that tab (activeTab). Unlike a tab chosen in the picker, the
 * extension knows which tab this is, which is what makes click tracking possible.
 */
export async function requestTargetTabStream(
  target: CaptureTarget,
  settings: Pick<UserSettings, 'resolution' | 'frameRate' | 'captureSystemAudio'>,
): Promise<MediaStream> {
  const consumer = await chrome.tabs.getCurrent();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: target.tabId, consumerTabId: consumer?.id });

  const video: TabConstraints = {
    mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxFrameRate: settings.frameRate },
  };
  if (settings.resolution !== 'native') {
    const [width, height] = RESOLUTION_LIMITS[settings.resolution];
    video.mandatory.maxWidth = width;
    video.mandatory.maxHeight = height;
  }
  const audio: TabConstraints | false = settings.captureSystemAudio
    ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
    : false;
  return navigator.mediaDevices.getUserMedia({ video, audio } as MediaStreamConstraints);
}

/**
 * Tab capture silences the tab for the user. Plays the captured tab audio back so the user still
 * hears the page while recording. Returns a function that stops playback.
 */
export function playTabAudio(stream: MediaStream): () => void {
  const tracks = stream.getAudioTracks();
  if (tracks.length === 0) return () => undefined;
  const context = new AudioContext();
  const source = context.createMediaStreamSource(new MediaStream(tracks));
  source.connect(context.destination);
  void context.resume();
  return () => {
    source.disconnect();
    void context.close();
  };
}
