import { saveDraft } from '@/services/storage/recordingDraftRepository';
import type { CameraLayout, CaptureSourceInfo, DraftTrack, RecordingDraft, RecordingTrackInfo, RecordingTrackKind } from '@/types';
import { createId } from '@/utils/id';
import { mixAudioTracks, type MixedAudio } from './audioMixer';
import { AUDIO_BITRATE, CAMERA_BITRATE, pickMimeType, videoBitrate } from './mimeTypes';
import { RecordingClock } from './RecordingClock';
import { TrackRecorder } from './TrackRecorder';

/** MediaRecorder emits a chunk this often; it bounds data loss if the tab or browser dies. */
const TIMESLICE_MS = 1000;

export type RecorderState = 'idle' | 'recording' | 'paused' | 'stopping' | 'stopped';

export interface RecordingInputs {
  display: MediaStream;
  camera: MediaStream | null;
  microphone: MediaStream | null;
}

export interface RecordingControllerOptions {
  sessionId: string;
  inputs: RecordingInputs;
  name: string;
  source: CaptureSourceInfo;
  cameraLayout: CameraLayout;
  /** A source track ended by itself (sharing stopped, device unplugged…). */
  onTrackEnded: (kind: RecordingTrackKind) => void;
  /** Recording cannot continue (recorder failure, storage full…). */
  onFatalError: (error: unknown) => void;
}

interface ActiveTrack {
  kind: RecordingTrackKind;
  recorder: TrackRecorder;
  info: DraftTrack;
  /** Source track(s) whose end means this recording track is over. */
  sources: MediaStreamTrack[];
}

/**
 * Records one session: the screen (video + mixed microphone/tab audio, the self-contained
 * playable file) and separate camera, microphone and system-audio tracks for the editor.
 *
 * Synchronisation: every MediaRecorder is started in the same task, then paused/resumed/stopped
 * together, so all outputs share one timeline. Each track's measured start skew relative to the
 * screen recorder is stored as `startOffsetMs`, and recorded time comes from one RecordingClock.
 */
export class RecordingController {
  readonly clock = new RecordingClock();
  private state: RecorderState = 'idle';
  private readonly draft: RecordingDraft;
  private readonly tracks: ActiveTrack[] = [];
  private readonly mixer: MixedAudio | null;
  private readonly cleanups: Array<() => void> = [];
  private draftWrites: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(private readonly options: RecordingControllerOptions) {
    const { display, camera, microphone } = options.inputs;
    const screenVideo = display.getVideoTracks()[0];
    if (!screenVideo || screenVideo.readyState !== 'live') throw new Error('The shared screen is no longer available.');

    const micTrack = microphone?.getAudioTracks().find((t) => t.readyState === 'live') ?? null;
    const systemTrack = display.getAudioTracks().find((t) => t.readyState === 'live') ?? null;
    const cameraTrack = camera?.getVideoTracks().find((t) => t.readyState === 'live') ?? null;

    const now = Date.now();
    this.draft = {
      id: options.sessionId,
      name: options.name,
      durationMs: 0,
      tracks: [],
      cameraLayout: cameraTrack ? options.cameraLayout : undefined,
      source: options.source,
      createdAt: now,
      updatedAt: now,
    };

    this.mixer = mixAudioTracks([micTrack, systemTrack].filter((t): t is MediaStreamTrack => t !== null));
    const screenSettings = screenVideo.getSettings();
    const screenStream = new MediaStream(this.mixer ? [screenVideo, this.mixer.track] : [screenVideo]);
    this.addTrack('screen', screenStream, [screenVideo], {
      mimeType: pickMimeType(this.mixer ? 'video+audio' : 'video'),
      videoBitsPerSecond: videoBitrate(screenSettings.width, screenSettings.height, screenSettings.frameRate),
      audioBitsPerSecond: AUDIO_BITRATE,
      label: options.source.label,
      width: screenSettings.width,
      height: screenSettings.height,
      hasAudio: this.mixer !== null,
    });

    if (cameraTrack) {
      const settings = cameraTrack.getSettings();
      this.addTrack('camera', new MediaStream([cameraTrack]), [cameraTrack], {
        mimeType: pickMimeType('video'),
        videoBitsPerSecond: CAMERA_BITRATE,
        label: cameraTrack.label || 'Camera',
        width: settings.width,
        height: settings.height,
        hasAudio: false,
      });
    }
    if (micTrack) {
      this.addTrack('microphone', new MediaStream([micTrack]), [micTrack], {
        mimeType: pickMimeType('audio'),
        audioBitsPerSecond: AUDIO_BITRATE,
        label: micTrack.label || 'Microphone',
        hasAudio: true,
      });
    }
    if (systemTrack) {
      this.addTrack('system-audio', new MediaStream([systemTrack]), [systemTrack], {
        mimeType: pickMimeType('audio'),
        audioBitsPerSecond: AUDIO_BITRATE,
        label: options.source.surface === 'browser' ? 'Tab audio' : 'System audio',
        hasAudio: true,
      });
    }
  }

  private addTrack(
    kind: RecordingTrackKind,
    stream: MediaStream,
    sources: MediaStreamTrack[],
    config: {
      mimeType: string;
      videoBitsPerSecond?: number;
      audioBitsPerSecond?: number;
      label: string;
      width?: number;
      height?: number;
      hasAudio: boolean;
    },
  ) {
    const info: DraftTrack = {
      id: createId('trk'),
      kind,
      mimeType: config.mimeType,
      label: config.label,
      startOffsetMs: 0,
      durationMs: 0,
      bytes: 0,
      width: config.width,
      height: config.height,
      hasAudio: config.hasAudio,
    };
    const recorder = new TrackRecorder({
      draftId: this.draft.id,
      trackId: info.id,
      stream,
      mimeType: config.mimeType,
      videoBitsPerSecond: config.videoBitsPerSecond,
      audioBitsPerSecond: config.audioBitsPerSecond,
      onChunk: (bytes) => this.onChunk(info, bytes),
      onError: (error) => this.fail(error),
    });
    const track: ActiveTrack = { kind, recorder, info, sources };
    this.tracks.push(track);
    this.draft.tracks.push(info);

    for (const source of sources) {
      const onEnded = () => void this.onSourceEnded(track);
      source.addEventListener('ended', onEnded);
      this.cleanups.push(() => source.removeEventListener('ended', onEnded));
    }
  }

  get recorderState(): RecorderState {
    return this.state;
  }

  get trackInfo(): RecordingTrackInfo[] {
    return this.tracks.map(({ kind, info }) => ({ kind, mimeType: info.mimeType, label: info.label }));
  }

  get screenMimeType(): string {
    return this.tracks[0]!.info.mimeType;
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') return;
    await saveDraft(this.draft);
    // Start every recorder in the same task so they share a common start instant.
    for (const track of this.tracks) track.recorder.start(TIMESLICE_MS);
    this.clock.start();
    this.state = 'recording';
  }

  pause(): void {
    if (this.state !== 'recording') return;
    for (const track of this.tracks) track.recorder.pause();
    this.clock.pause();
    this.state = 'paused';
    this.persistDraft();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    for (const track of this.tracks) track.recorder.resume();
    this.clock.resume();
    this.state = 'recording';
  }

  /** Silences the microphone (in its stem and in the screen recording's mix) without stopping it. */
  setMicrophoneMuted(muted: boolean): void {
    this.options.inputs.microphone?.getAudioTracks().forEach((track) => (track.enabled = !muted));
  }

  /** Records black frames on the camera track while hidden; the camera stays open. */
  setCameraHidden(hidden: boolean): void {
    this.options.inputs.camera?.getVideoTracks().forEach((track) => (track.enabled = !hidden));
  }

  setCameraLayout(layout: CameraLayout): void {
    if (this.draft.cameraLayout) this.draft.cameraLayout = layout;
  }

  /**
   * Stops every recorder, waits for all data to reach IndexedDB and releases internal resources.
   * Returns the draft id, ready for `finalizeDraft()`. The caller owns (and stops) the input streams.
   */
  async stop(): Promise<string> {
    if (this.state === 'stopping' || this.state === 'stopped') return this.draft.id;
    const endedAt = this.clock.elapsed();
    this.state = 'stopping';
    this.clock.pause();
    await Promise.allSettled(this.tracks.map((track) => track.recorder.stop()));
    this.updateDurations(endedAt);
    this.persistDraft();
    await this.draftWrites;
    this.dispose();
    this.state = 'stopped';
    return this.draft.id;
  }

  private updateDurations(elapsed: number) {
    this.draft.durationMs = Math.max(this.draft.durationMs, elapsed);
    const screenStart = this.tracks[0]?.recorder.startedAt ?? null;
    for (const { info, recorder } of this.tracks) {
      if (screenStart !== null && recorder.startedAt !== null) {
        info.startOffsetMs = Math.max(0, Math.round(recorder.startedAt - screenStart));
      }
      if (!info.endedEarly) info.durationMs = Math.max(0, elapsed - info.startOffsetMs);
    }
  }

  private onChunk(info: DraftTrack, bytes: number) {
    info.bytes += bytes;
    // The screen track emits once per timeslice: use it to checkpoint the draft's durations.
    if (info === this.tracks[0]?.info && this.state === 'recording') {
      this.updateDurations(this.clock.elapsed());
      this.persistDraft();
    }
  }

  private persistDraft() {
    const snapshot = structuredClone(this.draft);
    this.draftWrites = this.draftWrites.then(() => saveDraft(snapshot)).catch((error) => this.fail(error));
  }

  private async onSourceEnded(track: ActiveTrack) {
    if (this.state !== 'recording' && this.state !== 'paused') return;
    const elapsed = this.clock.elapsed();
    this.updateDurations(elapsed);
    // The screen ending ends the whole recording, so only other sources can end "early".
    if (track.kind !== 'screen') track.info.endedEarly = true;
    await track.recorder.stop();
    this.persistDraft();
    this.options.onTrackEnded(track.kind);
  }

  private fail(error: unknown) {
    if (this.failed) return;
    this.failed = true;
    this.options.onFatalError(error);
  }

  private dispose() {
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    this.mixer?.dispose();
  }
}
