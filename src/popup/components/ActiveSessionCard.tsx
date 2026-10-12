import { useEffect, useState } from 'react';
import { ArrowUpRight, Pause, Play, Square } from 'lucide-react';
import { sendMessage } from '@/services/messaging';
import { CAPTURE_SOURCE_NOUN } from '@/shared/captureSources';
import { Button, StatusBadge, useToast } from '@/shared/components';
import { useSessionElapsed } from '@/shared/sessionTiming';
import type { RecordingAction, RecordingSession } from '@/types';
import { getErrorMessage } from '@/utils/errors';
import { formatClock } from '@/utils/format';

/**
 * Shown instead of the setup controls while a session is open, so only one can exist at a time.
 * While recording it doubles as a remote control for the studio tab.
 */
export function ActiveSessionCard({ session }: { session: RecordingSession }) {
  const toast = useToast();
  const [busy, setBusy] = useState<RecordingAction | 'open' | null>(null);
  const elapsed = useSessionElapsed(session.timing);
  const live = session.status === 'recording' || session.status === 'paused';

  // Opening the popup on the recorded tab grants ZoomCapture access to it again (activeTab),
  // e.g. after it navigated to another site: let the studio resume click tracking there.
  const targetTabId = session.options.target?.tabId;
  useEffect(() => {
    if (targetTabId === undefined) return;
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id === targetTabId) {
        void chrome.runtime
          .sendMessage({ channel: 'tracking-reattach', sessionId: session.id, tabId: targetTabId })
          .catch(() => undefined);
      }
    });
  }, [targetTabId, session.id]);

  const openStudio = async () => {
    setBusy('open');
    try {
      await sendMessage('session/start', { options: session.options });
      window.close();
    } catch (error) {
      toast.show({ variant: 'error', title: 'Could not open the studio', description: getErrorMessage(error) });
      setBusy(null);
    }
  };

  const control = async (action: RecordingAction) => {
    setBusy(action);
    try {
      await sendMessage('recording/control', { sessionId: session.id, action });
      if (action === 'stop') window.close();
    } catch (error) {
      toast.show({ variant: 'error', title: `Could not ${action} the recording`, description: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      aria-labelledby="active-session-heading"
      className="space-y-3 rounded-2xl border border-accent/40 bg-accent-soft p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="active-session-heading" className="text-sm font-semibold">
          {live ? 'Recording in progress' : 'Session in progress'}
        </h2>
        <StatusBadge status={session.status} />
      </div>

      {live ? (
        <>
          <p role="timer" aria-label="Recorded time" className="font-mono text-3xl font-semibold tabular-nums">
            {formatClock(elapsed)}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {session.status === 'paused' ? (
              <Button icon={Play} loading={busy === 'resume'} onClick={() => void control('resume')}>
                Resume
              </Button>
            ) : (
              <Button icon={Pause} loading={busy === 'pause'} onClick={() => void control('pause')}>
                Pause
              </Button>
            )}
            <Button variant="record" icon={Square} loading={busy === 'stop'} onClick={() => void control('stop')}>
              Stop
            </Button>
          </div>
        </>
      ) : (
        <p className="text-xs text-fg-muted">
          {session.status === 'finalizing'
            ? 'Saving the recording…'
            : session.selectedSurface
              ? `Sharing: ${session.selectedSurface.label}`
              : `Waiting for you to choose a ${CAPTURE_SOURCE_NOUN[session.options.source]}.`}
        </p>
      )}

      <Button
        variant={live ? 'ghost' : 'primary'}
        fullWidth
        icon={ArrowUpRight}
        loading={busy === 'open'}
        onClick={() => void openStudio()}
      >
        Open Recording Studio
      </Button>
    </section>
  );
}
