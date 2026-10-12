import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleOff, Info, Settings, X } from 'lucide-react';
import { sendMessage } from '@/services/messaging';
import { requestCameraStream, requestMicrophoneStream } from '@/services/media/userMedia';
import { getQueryParam } from '@/services/navigation';
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
  useToast,
} from '@/shared/components';
import { useActiveSession } from '@/shared/hooks/useActiveSession';
import { useSettings } from '@/shared/hooks/useSettings';
import type { CaptureOptions, SelectedSurface } from '@/types';
import { getErrorMessage, isPickerDismissed } from '@/utils/errors';
import { CameraPanel, MicrophonePanel } from './components/DevicePanels';
import { SourcePreview } from './components/SourcePreview';
import { useDisplayCapture } from './hooks/useDisplayCapture';
import { useUserMediaStream } from './hooks/useUserMediaStream';

const sessionId = getQueryParam('session');

async function closeThisTab() {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
}

/**
 * Recording Studio. Owns every media stream for a session: the shared surface, camera and
 * microphone. The background service worker tracks the session state; this page reports
 * what the user picked. Turning these streams into a recording is the job of Module 02.
 */
export function RecordingPage() {
  const toast = useToast();
  const { settings } = useSettings();
  const { session: activeSession, loaded } = useActiveSession();
  const session = activeSession && activeSession.id === sessionId ? activeSession : null;

  const [selecting, setSelecting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const liveRef = useRef(false);
  liveRef.current = session !== null;

  const reportError = useCallback(
    (title: string) => (error: unknown) =>
      toast.show({ variant: 'error', title, description: getErrorMessage(error) }),
    [toast],
  );

  const onSurfaceChange = useCallback(
    (surface: SelectedSurface | null) => {
      // Once the session has ended there is nothing left to report to.
      if (!sessionId || !liveRef.current) return;
      void sendMessage('session/set-surface', { sessionId, surface })
        .then(() => sendMessage('session/set-status', { sessionId, status: surface ? 'source-ready' : 'preparing' }))
        .catch(reportError('Could not update the session'));
    },
    [reportError],
  );

  const display = useDisplayCapture(onSurfaceChange);
  const camera = useUserMediaStream(
    session !== null && session.options.camera,
    settings?.cameraDeviceId ?? '',
    requestCameraStream,
    'camera',
  );
  const microphone = useUserMediaStream(
    session !== null && session.options.microphone,
    settings?.microphoneDeviceId ?? '',
    requestMicrophoneStream,
    'microphone',
  );

  // Release the shared surface as soon as the session ends (cancelled here or elsewhere).
  const { stream: displayStream, stop: stopDisplay } = display;
  useEffect(() => {
    if (loaded && !session && displayStream) stopDisplay();
  }, [loaded, session, displayStream, stopDisplay]);

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

  const cancelSession = async () => {
    if (!sessionId) return;
    await sendMessage('session/cancel', { sessionId }).catch(reportError('Could not cancel the session'));
  };

  const startNewSession = async () => {
    if (!settings) return;
    try {
      await sendMessage('session/start', {
        options: { source: settings.defaultSource, camera: settings.cameraEnabled, microphone: settings.microphoneEnabled },
      });
      await closeThisTab();
    } catch (error) {
      reportError('Could not start a new session')(error);
    }
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-line bg-canvas/85 px-6 py-3 backdrop-blur">
        <Logo subtitle="Recording Studio" />
        {session && <StatusBadge status={session.status} className="ml-2" />}
        <div className="ml-auto flex items-center gap-2">
          <IconButton
            icon={Settings}
            label="Open settings"
            tooltipSide="bottom"
            onClick={() => void sendMessage('page/open', { page: 'settings' })}
          />
          {session && (
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

      {!loaded ? null : !session ? (
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
      ) : (
        <main className="mx-auto grid w-full max-w-7xl flex-1 gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-4">
            <SourcePreview
              source={session.options.source}
              stream={display.stream}
              surface={display.surface}
              selecting={selecting}
              disabled={!settings}
              onSelect={() => void selectSource()}
              onStop={display.stop}
            />
            <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-4">
              <Info size={18} aria-hidden className="mt-0.5 shrink-0 text-accent-2" />
              <div className="text-sm">
                <p className="font-medium">Recording is not available in this build yet</p>
                <p className="mt-1 text-fg-muted">
                  Source selection, live previews and device checks on this page are fully working. Capturing them
                  into an editable project arrives with the recording engine.
                </p>
              </div>
            </div>
          </div>

          <aside className="space-y-4" aria-label="Capture setup">
            <Panel title="Source" description="Pre-selects this tab in Chrome's sharing picker.">
              <SegmentedControl
                label="Preferred capture source"
                options={CAPTURE_SOURCE_OPTIONS}
                value={session.options.source}
                onChange={(source) => setOptions({ source })}
              />
            </Panel>
            <CameraPanel
              enabled={session.options.camera}
              stream={camera.stream}
              error={camera.error}
              pending={camera.pending}
              onToggle={(enabled) => setOptions({ camera: enabled })}
              onRetry={camera.retry}
            />
            <MicrophonePanel
              enabled={session.options.microphone}
              stream={microphone.stream}
              error={microphone.error}
              pending={microphone.pending}
              onToggle={(enabled) => setOptions({ microphone: enabled })}
              onRetry={microphone.retry}
            />
          </aside>
        </main>
      )}

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
