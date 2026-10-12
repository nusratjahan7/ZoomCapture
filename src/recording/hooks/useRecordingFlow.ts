import { useCallback, useEffect, useRef, useState } from 'react';
import { sendMessage } from '@/services/messaging';
import { ensureThumbnail } from '@/services/media/thumbnail';
import { finalizeDraft } from '@/services/recording/finalizeRecording';
import { notifyLibraryChanged } from '@/services/storage/libraryEvents';
import { RecordingController } from '@/services/recording/RecordingController';
import { deleteDraft } from '@/services/storage/recordingDraftRepository';
import type {
  CameraLayout,
  RecordingAction,
  RecordingTrackKind,
  SaveProgress,
  SelectedSurface,
  SessionStatus,
  UserSettings,
} from '@/types';
import { describeStorageError, isQuotaError } from '@/utils/storageErrors';

/** Longest the save screen waits for a thumbnail before showing the saved recording. */
const THUMBNAIL_WAIT_MS = 4000;

export type FlowPhase = 'setup' | 'countdown' | 'starting' | 'recording' | 'paused' | 'saving' | 'done' | 'failed';

/** Phases during which the recording owns the media and settings are locked. */
export const ACTIVE_PHASES: readonly FlowPhase[] = ['countdown', 'starting', 'recording', 'paused', 'saving'];

export interface FlowInputs {
  sessionId: string | null;
  display: MediaStream | null;
  surface: SelectedSurface | null;
  camera: MediaStream | null;
  microphone: MediaStream | null;
  settings: UserSettings | null;
}

export interface FlowCallbacks {
  onTrackEnded: (kind: RecordingTrackKind) => void;
  onError: (title: string, error: unknown) => void;
  /** Stop every input stream once the recorders are done with them. */
  releaseMedia: () => void;
  onSaved: (recordingId: string) => void;
}

export interface SaveFailure {
  message: string;
  /** Out of disk space: freeing space and retrying will work. */
  storageFull: boolean;
  /** Draft that still holds everything captured; saving can be retried. */
  draftId: string | null;
}

function recordingName(): string {
  return `Recording ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date())}`;
}

/**
 * Drives one recording: countdown → start → pause/resume → stop → save as a Recording,
 * keeping the background session status in step. Media handling lives in RecordingController.
 */
export function useRecordingFlow(inputs: FlowInputs, callbacks: FlowCallbacks) {
  const [phase, setPhase] = useState<FlowPhase>('setup');
  const [countdown, setCountdown] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [saveProgress, setSaveProgress] = useState<SaveProgress | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [cameraHidden, setCameraHidden] = useState(false);
  const [screenMimeType, setScreenMimeType] = useState<string | null>(null);
  const [recordedKinds, setRecordedKinds] = useState<RecordingTrackKind[]>([]);

  const controllerRef = useRef<RecordingController | null>(null);
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const report = useCallback(async (status: SessionStatus, error?: string) => {
    const { sessionId } = inputsRef.current;
    if (sessionId) await sendMessage('session/set-status', { sessionId, status, error });
  }, []);

  // Timer: read from the controller's clock so it matches the recorded media exactly.
  useEffect(() => {
    if (phase !== 'recording') return;
    const id = window.setInterval(() => setElapsedMs(controllerRef.current?.clock.elapsed() ?? 0), 200);
    return () => window.clearInterval(id);
  }, [phase]);

  /** Saves a captured draft (resumable). Shared by Stop and Retry saving. */
  const save = useCallback(
    async (draftId: string) => {
      const { sessionId } = inputsRef.current;
      phaseRef.current = 'saving';
      setPhase('saving');
      setFailure(null);
      try {
        const { recording } = await finalizeDraft(draftId, { onProgress: setSaveProgress });
        setSaveProgress({ stage: 'thumbnail', fraction: 0.97 });
        // The recording is already saved. A thumbnail is optional: wait briefly, then let it finish in
        // the background (the library also creates missing thumbnails on first display).
        const thumbnail = ensureThumbnail(recording.id).then((assetId) => {
          if (assetId) notifyLibraryChanged({ type: 'thumbnail', recordingId: recording.id });
        });
        await Promise.race([thumbnail, new Promise((resolve) => setTimeout(resolve, THUMBNAIL_WAIT_MS))]);
        setSaveProgress({ stage: 'done', fraction: 1 });
        notifyLibraryChanged({ type: 'saved', recordingId: recording.id });
        if (sessionId) await sendMessage('session/complete', { sessionId, recordingId: recording.id }).catch(() => undefined);
        setRecordingId(recording.id);
        setPhase('done');
        callbacksRef.current.onSaved(recording.id);
      } catch (error) {
        const message = describeStorageError(error);
        setFailure({ message, storageFull: isQuotaError(error), draftId });
        setPhase('failed');
        notifyLibraryChanged({ type: 'drafts' });
        await report('error', message).catch(() => undefined);
      }
    },
    [report],
  );

  const stop = useCallback(async () => {
    const controller = controllerRef.current;
    if (!controller || (phaseRef.current !== 'recording' && phaseRef.current !== 'paused')) return;
    phaseRef.current = 'saving';
    setPhase('saving');
    setSaveProgress({ stage: 'preparing', fraction: 0 });
    setElapsedMs(controller.clock.elapsed());
    controllerRef.current = null;
    await report('finalizing').catch(() => undefined);
    // The draft id is the session id; if flushing fails the draft still holds what was written.
    let draftId = inputsRef.current.sessionId ?? '';
    try {
      draftId = await controller.stop();
    } catch {
      // Saving below reports the problem with a retry option.
    } finally {
      callbacksRef.current.releaseMedia();
    }
    await save(draftId);
  }, [report, save]);

  /** Retries a failed save after the user freed space; continues where the last attempt stopped. */
  const retrySave = useCallback(() => {
    if (phaseRef.current === 'failed' && failure?.draftId) void save(failure.draftId);
  }, [failure, save]);

  const begin = useCallback(async () => {
    const { sessionId, display, surface, camera, microphone, settings } = inputsRef.current;
    if (!sessionId || !display || !surface || !settings) return;
    phaseRef.current = 'starting';
    setPhase('starting');

    let controller: RecordingController | null = null;
    try {
      controller = new RecordingController({
        sessionId,
        inputs: { display, camera, microphone },
        name: recordingName(),
        source: { surface: surface.surface, label: surface.label },
        cameraLayout: settings.cameraBubble,
        onTrackEnded: (kind) => {
          callbacksRef.current.onTrackEnded(kind);
          if (kind === 'screen') void stop();
        },
        onFatalError: (error) => {
          callbacksRef.current.onError('Recording stopped unexpectedly', error);
          void stop();
        },
      });
      controllerRef.current = controller;
      await controller.start();
      setMicMuted(false);
      setCameraHidden(false);
      setElapsedMs(0);
      setScreenMimeType(controller.screenMimeType);
      setRecordedKinds(controller.trackInfo.map((track) => track.kind));
      phaseRef.current = 'recording';
      setPhase('recording');
      await sendMessage('session/set-tracks', { sessionId, tracks: controller.trackInfo });
      await report('recording');
    } catch (error) {
      if (controllerRef.current === controller && phaseRef.current === 'starting') {
        controllerRef.current = null;
        await controller?.stop().catch(() => undefined);
        await deleteDraft(sessionId).catch(() => undefined);
        phaseRef.current = 'setup';
        setPhase('setup');
        await report('source-ready').catch(() => undefined);
      }
      callbacksRef.current.onError('Could not start recording', error);
    }
  }, [report, stop]);

  // Countdown ticks; recording begins when it reaches zero.
  useEffect(() => {
    if (phase !== 'countdown') return;
    if (countdown <= 0) {
      void begin();
      return;
    }
    const id = window.setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => window.clearTimeout(id);
  }, [phase, countdown, begin]);

  const start = useCallback(() => {
    const seconds = inputsRef.current.settings?.countdownSeconds ?? 0;
    if (phaseRef.current !== 'setup') return;
    if (seconds === 0) {
      void begin();
      return;
    }
    setCountdown(seconds);
    phaseRef.current = 'countdown';
    setPhase('countdown');
    void report('countdown').catch((error) => callbacksRef.current.onError('Could not start recording', error));
  }, [begin, report]);

  const cancelCountdown = useCallback(() => {
    if (phaseRef.current !== 'countdown') return;
    phaseRef.current = 'setup';
    setPhase('setup');
    void report('source-ready').catch(() => undefined);
  }, [report]);

  const pause = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller || phaseRef.current !== 'recording') return;
    controller.pause();
    phaseRef.current = 'paused';
    setPhase('paused');
    setElapsedMs(controller.clock.elapsed());
    void report('paused').catch(() => undefined);
  }, [report]);

  const resume = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller || phaseRef.current !== 'paused') return;
    controller.resume();
    phaseRef.current = 'recording';
    setPhase('recording');
    void report('recording').catch(() => undefined);
  }, [report]);

  const toggleMicMuted = useCallback(() => {
    setMicMuted((muted) => {
      controllerRef.current?.setMicrophoneMuted(!muted);
      return !muted;
    });
  }, []);

  const toggleCameraHidden = useCallback(() => {
    setCameraHidden((hidden) => {
      controllerRef.current?.setCameraHidden(!hidden);
      return !hidden;
    });
  }, []);

  const updateCameraLayout = useCallback((layout: CameraLayout) => {
    controllerRef.current?.setCameraLayout(layout);
  }, []);

  /** Handles a command from outside the studio; returns an error message if it does not apply. */
  const command = useCallback(
    (action: RecordingAction): string | null => {
      const current = phaseRef.current;
      if (action === 'pause' && current === 'recording') pause();
      else if (action === 'resume' && current === 'paused') resume();
      else if (action === 'stop' && (current === 'recording' || current === 'paused')) void stop();
      else return `Cannot ${action} while the recording is ${current}.`;
      return null;
    },
    [pause, resume, stop],
  );

  return {
    phase,
    countdown,
    elapsedMs,
    recordingId,
    failure,
    saveProgress,
    retrySave,
    micMuted,
    cameraHidden,
    screenMimeType,
    recordedKinds,
    start,
    cancelCountdown,
    pause,
    resume,
    stop,
    toggleMicMuted,
    toggleCameraHidden,
    updateCameraLayout,
    command,
  };
}
