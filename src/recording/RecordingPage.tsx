import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleOff, FolderOpen, RotateCcw, Settings, TriangleAlert, Volume2, X } from 'lucide-react';
import { sendMessage } from '@/services/messaging';
import { requestCameraStream, requestMicrophoneStream } from '@/services/media/userMedia';
import { getQueryParam } from '@/services/navigation';
import { findSupportedMimeType } from '@/services/recording/mimeTypes';
import { availableSpace, LOW_SPACE_BYTES, requestPersistentStorage } from '@/services/storage/storageStatus';
import { formatBytes } from '@/utils/format';
import { CAPTURE_SOURCE_OPTIONS } from '@/shared/captureSources';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Logo,
  Panel,
  SegmentedControl,
  StatusBadge,
  Toggle,
  useToast,
} from '@/shared/components';
import { useActiveSession } from '@/shared/hooks/useActiveSession';
import { useMediaDevices } from '@/shared/hooks/useMediaDevices';
import { useSettings } from '@/shared/hooks/useSettings';
import type { CameraLayout, CaptureOptions, RecordingTrackKind, SelectedSurface } from '@/types';
import { getErrorMessage, isPickerDismissed } from '@/utils/errors';
import { CameraBubble } from './components/CameraBubble';
import { DevicePanel } from './components/DevicePanels';
import { FLOATING_SIZE, FloatingControls } from './components/FloatingControls';
import { RecordingControls } from './components/RecordingControls';
import { RecordingResult } from './components/RecordingResult';
import { SavingProgress } from './components/SavingProgress';
import { SourcePreview } from './components/SourcePreview';
import { useDisplayCapture } from './hooks/useDisplayCapture';
import { useDocumentPip } from './hooks/useDocumentPip';
import { ACTIVE_PHASES, useRecordingFlow, type FlowPhase } from './hooks/useRecordingFlow';
import { useStudioCommands } from './hooks/useStudioCommands';
import { useUserMediaStream } from './hooks/useUserMediaStream';

const sessionId = getQueryParam('session');

const TRACK_ENDED_MESSAGES: Record<RecordingTrackKind, { title: string; description: string }> = {
  screen: { title: 'Screen sharing ended', description: 'The recording was stopped and saved.' },
  camera: { title: 'Camera disconnected', description: 'Recording continues without the camera.' },
  microphone: { title: 'Microphone disconnected', description: 'Recording continues without the microphone.' },
  'system-audio': { title: 'Tab/system audio ended', description: 'Recording continues without it.' },
};

async function closeThisTab() {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
}

/**
 * Recording Studio. Owns every media stream of a session (shared surface, camera, microphone)
 * and the recorders. The background service worker tracks session state; the popup and the
 * floating Picture-in-Picture window control the recording through this page.
 */
export function RecordingPage() {
  const toast = useToast();
  const { settings, update } = useSettings();
  const { session: activeSession, loaded } = useActiveSession();
  const session = activeSession && activeSession.id === sessionId ? activeSession : null;
  const devices = useMediaDevices();
  const pip = useDocumentPip();

  const [selecting, setSelecting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [released, setReleased] = useState(false);
  const [bubbleDraft, setBubbleDraft] = useState<CameraLayout | null>(null);
  const liveRef = useRef(false);
  liveRef.current = session !== null;
  const phaseRef = useRef<FlowPhase>('setup');

  const reportError = useCallback(
    (title: string) => (error: unknown) => toast.show({ variant: 'error', title, description: getErrorMessage(error) }),
    [toast],
  );

  const onSurfaceChange = useCallback(
    (surface: SelectedSurface | null) => {
      // Once recording starts the recording flow owns the session status.
      if (!sessionId || !liveRef.current || phaseRef.current !== 'setup') return;
      void sendMessage('session/set-surface', { sessionId, surface })
        .then(() => sendMessage('session/set-status', { sessionId, status: surface ? 'source-ready' : 'preparing' }))
        .catch(reportError('Could not update the session'));
    },
    [reportError],
  );

  const display = useDisplayCapture(onSurfaceChange);
  const camera = useUserMediaStream(
    session !== null && session.options.camera && !released,
    settings?.cameraDeviceId ?? '',
    requestCameraStream,
    'camera',
  );
  const microphone = useUserMediaStream(
    session !== null && session.options.microphone && !released,
    settings?.microphoneDeviceId ?? '',
    requestMicrophoneStream,
    'microphone',
  );

  const flow = useRecordingFlow(
    {
      sessionId,
      display: display.stream,
      surface: display.surface,
      camera: camera.stream,
      microphone: microphone.stream,
      settings,
    },
    {
      onTrackEnded: (kind) => toast.show({ variant: kind === 'screen' ? 'info' : 'error', ...TRACK_ENDED_MESSAGES[kind] }),
      onError: (title, error) => reportError(title)(error),
      releaseMedia: () => {
        setReleased(true);
        display.stop();
        pip.close();
      },
      onSaved: () => toast.show({ variant: 'success', title: 'Recording saved', description: 'It is stored on this device.' }),
    },
  );
  phaseRef.current = flow.phase;
  const active = ACTIVE_PHASES.includes(flow.phase);
  const recording = flow.phase === 'recording' || flow.phase === 'paused';
  useStudioCommands(sessionId, flow.command);

  // Device names become available once access is granted; refresh the lists when streams start.
  const { refresh: refreshDevices } = devices;
  useEffect(() => {
    void refreshDevices();
  }, [camera.stream, microphone.stream, refreshDevices]);

  // Release the shared surface if the session ends before recording (cancelled here or elsewhere).
  const { stream: displayStream, stop: stopDisplay } = display;
  useEffect(() => {
    if (loaded && !session && displayStream && flow.phase === 'setup') stopDisplay();
  }, [loaded, session, displayStream, stopDisplay, flow.phase]);

  // Ask before closing the tab mid-recording. (If it is closed anyway, the background saves it.)
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [active]);

  const mimeType = useMemo(() => {
    if (flow.screenMimeType) return flow.screenMimeType;
    const hasAudio = Boolean(microphone.stream || display.surface?.hasAudio);
    return findSupportedMimeType(hasAudio ? 'video+audio' : 'video');
  }, [flow.screenMimeType, microphone.stream, display.surface?.hasAudio]);

  const setOptions = (options: Partial<CaptureOptions>) => {
    if (!sessionId) return;
    void sendMessage('session/set-options', { sessionId, options }).catch(reportError('Could not update the session'));
  };

  const selectSource = async () => {
    if (!session || !settings) return;
    setSelecting(true);
    try {
      await display.select(session.options.source, settings);
    } catch (error) {
      if (isPickerDismissed(error)) {
        toast.show({ title: 'Sharing was cancelled', description: 'Choose a source whenever you are ready.' });
      } else {
        reportError('Could not start screen sharing')(error);
      }
    } finally {
      setSelecting(false);
    }
  };

  const openFloatingControls = () => {
    const size = camera.stream ? FLOATING_SIZE.withCamera : FLOATING_SIZE.controlsOnly;
    void pip.open(size).catch((error: unknown) =>
      toast.show({ title: 'Floating controls are unavailable', description: getErrorMessage(error) }),
    );
  };

  const startRecording = () => {
    // Picture-in-Picture needs the click's user activation, so it opens here, before the countdown.
    if (settings?.floatingControls && pip.supported) openFloatingControls();
    flow.start();
    void availableSpace().then((free) => {
      if (free !== undefined && free < LOW_SPACE_BYTES) {
        toast.show({
          variant: 'error',
          title: 'Storage is running low',
          description: `About ${formatBytes(free)} left. Recording continues; if space runs out, everything captured so far is kept.`,
        });
      }
    });
  };

  // Ask the browser to keep recordings even under storage pressure (granted silently for extensions).
  useEffect(() => {
    void requestPersistentStorage();
  }, []);

  const cancelCountdown = () => {
    flow.cancelCountdown();
    pip.close();
  };

  const cancelSession = async () => {
    if (!sessionId) return;
    await sendMessage('session/cancel', { sessionId }).catch(reportError('Could not cancel the session'));
  };

  /** Starts a new session in this tab (after a finished recording or an ended session). */
  const startNewSession = async () => {
    if (!settings) return;
    try {
      const next = await sendMessage('session/start', {
        inPlace: true,
        options: { source: settings.defaultSource, camera: settings.cameraEnabled, microphone: settings.microphoneEnabled },
      });
      window.location.replace(`?session=${encodeURIComponent(next.id)}`);
    } catch (error) {
      reportError('Could not start a new session')(error);
    }
  };

  const bubbleLayout = bubbleDraft ?? settings?.cameraBubble ?? null;
  const moveBubble = (layout: CameraLayout) => {
    setBubbleDraft(layout);
    flow.updateCameraLayout(layout);
  };
  const commitBubble = (layout: CameraLayout) => {
    moveBubble(layout);
    void update({ cameraBubble: layout }).then(() => setBubbleDraft(null));
  };

  const recordingCamera = recording && flow.recordedKinds.includes('camera');
  const recordingMic = recording && flow.recordedKinds.includes('microphone');

  const floatingWindow =
    pip.pipWindow &&
    createPortal(
      <FloatingControls
        phase={flow.phase}
        countdown={flow.countdown}
        elapsedMs={flow.elapsedMs}
        camera={camera.stream}
        cameraHidden={flow.cameraHidden}
        micAvailable={recordingMic}
        micMuted={flow.micMuted}
        onPause={flow.pause}
        onResume={flow.resume}
        onStop={() => void flow.stop()}
        onToggleMic={flow.toggleMicMuted}
        onToggleCamera={flow.toggleCameraHidden}
      />,
      pip.pipWindow.document.body,
    );

  let content;
  if (flow.phase === 'done' && flow.recordingId) {
    content = <RecordingResult recordingId={flow.recordingId} onRecordAgain={() => void startNewSession()} />;
  } else if (flow.phase === 'saving') {
    content = <SavingProgress progress={flow.saveProgress} />;
  } else if (flow.phase === 'failed') {
    content = (
      <main className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          icon={TriangleAlert}
          title={flow.failure?.storageFull ? 'Not enough storage to save the recording' : 'The recording could not be saved'}
          description={`${flow.failure?.message ?? 'Unknown error.'} Your captured media is kept safely until it is saved or you discard it in the library.`}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button icon={FolderOpen} onClick={() => void sendMessage('page/open', { page: 'editor' })}>
                Open library
              </Button>
              {flow.failure?.draftId && (
                <Button variant="primary" icon={RotateCcw} onClick={flow.retrySave}>
                  Retry saving
                </Button>
              )}
            </div>
          }
        />
      </main>
    );
  } else if (!loaded) {
    content = null;
  } else if (!session) {
    content = (
      <main className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          icon={CircleOff}
          title="This recording session has ended"
          description="Sessions end when they are cancelled or when their studio tab is closed."
          action={
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => void closeThisTab()}>
                Close tab
              </Button>
              <Button variant="primary" disabled={!settings} onClick={() => void startNewSession()}>
                Start a new session
              </Button>
            </div>
          }
        />
      </main>
    );
  } else {
    content = (
      <main className="mx-auto grid w-full max-w-7xl flex-1 gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <SourcePreview
            source={session.options.source}
            stream={display.stream}
            surface={display.surface}
            audioRequested={settings?.captureSystemAudio ?? false}
            selecting={selecting}
            disabled={!settings}
            recording={recording}
            onSelect={() => void selectSource()}
            overlay={
              <>
                {camera.stream && bubbleLayout && (
                  <CameraBubble
                    stream={camera.stream}
                    layout={bubbleLayout}
                    hidden={flow.cameraHidden}
                    onMove={moveBubble}
                    onCommit={commitBubble}
                  />
                )}
                {flow.phase === 'countdown' && (
                  <div
                    aria-live="assertive"
                    className="absolute inset-0 z-20 flex items-center justify-center bg-black/55 text-8xl font-bold text-white"
                  >
                    {flow.countdown}
                  </div>
                )}
              </>
            }
            footer={
              display.stream && (
                <RecordingControls
                  phase={flow.phase}
                  countdown={flow.countdown}
                  elapsedMs={flow.elapsedMs}
                  mimeType={mimeType}
                  selecting={selecting}
                  micAvailable={recordingMic}
                  micMuted={flow.micMuted}
                  floating={{ supported: pip.supported, open: pip.pipWindow !== null, onOpen: openFloatingControls }}
                  onStart={startRecording}
                  onCancelCountdown={cancelCountdown}
                  onPause={flow.pause}
                  onResume={flow.resume}
                  onStop={() => void flow.stop()}
                  onToggleMic={flow.toggleMicMuted}
                  onChangeSource={() => void selectSource()}
                  onStopSharing={display.stop}
                />
              )
            }
          />
        </div>

        <aside className="space-y-4" aria-label="Capture setup">
          <Panel title="Source" description="Pre-selects this option in Chrome's sharing picker.">
            <SegmentedControl
              label="Preferred capture source"
              options={CAPTURE_SOURCE_OPTIONS}
              value={session.options.source}
              onChange={(source) => setOptions({ source })}
              disabled={active}
            />
            <Toggle
              className="mt-2"
              icon={Volume2}
              label="Share tab / system audio"
              description="Applies the next time you choose a source"
              checked={settings?.captureSystemAudio ?? false}
              onCheckedChange={(captureSystemAudio) => void update({ captureSystemAudio })}
              disabled={active || !settings}
            />
          </Panel>
          <DevicePanel
            kind="camera"
            enabled={session.options.camera}
            stream={camera.stream}
            error={camera.error}
            pending={camera.pending}
            usingFallback={camera.usingFallback}
            devices={devices.inventory?.cameras ?? []}
            deviceId={settings?.cameraDeviceId ?? ''}
            locked={active}
            inRecording={recordingCamera}
            suppressed={flow.cameraHidden}
            showPreview={!display.stream}
            bubbleSize={bubbleLayout?.size}
            onBubbleSizeChange={(size) => bubbleLayout && commitBubble({ ...bubbleLayout, size })}
            onToggle={(enabled) => setOptions({ camera: enabled })}
            onToggleSuppressed={flow.toggleCameraHidden}
            onDeviceChange={(cameraDeviceId) => void update({ cameraDeviceId })}
            onRetry={camera.retry}
          />
          <DevicePanel
            kind="microphone"
            enabled={session.options.microphone}
            stream={microphone.stream}
            error={microphone.error}
            pending={microphone.pending}
            usingFallback={microphone.usingFallback}
            devices={devices.inventory?.microphones ?? []}
            deviceId={settings?.microphoneDeviceId ?? ''}
            locked={active}
            inRecording={recordingMic}
            suppressed={flow.micMuted}
            onToggle={(enabled) => setOptions({ microphone: enabled })}
            onToggleSuppressed={flow.toggleMicMuted}
            onDeviceChange={(microphoneDeviceId) => void update({ microphoneDeviceId })}
            onRetry={microphone.retry}
          />
        </aside>
      </main>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 flex items-center gap-4 border-b border-line bg-canvas/85 px-6 py-3 backdrop-blur">
        <Logo subtitle="Recording Studio" />
        {session && <StatusBadge status={session.status} className="ml-2" />}
        <div className="ml-auto flex items-center gap-2">
          <IconButton
            icon={Settings}
            label="Open settings"
            tooltipSide="bottom"
            onClick={() => void sendMessage('page/open', { page: 'settings' })}
          />
          {session && !active && (
            <Button
              variant="ghost"
              icon={X}
              onClick={() => (display.stream ? setConfirmCancel(true) : void cancelSession())}
            >
              Cancel session
            </Button>
          )}
        </div>
      </header>

      {content}
      {floatingWindow}

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={cancelSession}
        title="Cancel this session?"
        description="Screen sharing, camera and microphone will be released and this tab will close."
        confirmLabel="Cancel session"
        tone="danger"
      />
    </div>
  );
}
