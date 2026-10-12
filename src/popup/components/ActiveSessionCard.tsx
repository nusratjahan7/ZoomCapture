import { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { sendMessage } from '@/services/messaging';
import { CAPTURE_SOURCE_NOUN } from '@/shared/captureSources';
import { Button, StatusBadge, useToast } from '@/shared/components';
import type { RecordingSession } from '@/types';
import { getErrorMessage } from '@/utils/errors';

/** Shown instead of the setup controls while a session is open, so only one can exist at a time. */
export function ActiveSessionCard({ session }: { session: RecordingSession }) {
  const toast = useToast();
  const [opening, setOpening] = useState(false);

  const openStudio = async () => {
    setOpening(true);
    try {
      await sendMessage('session/start', { options: session.options });
      window.close();
    } catch (error) {
      toast.show({ variant: 'error', title: 'Could not open the studio', description: getErrorMessage(error) });
      setOpening(false);
    }
  };

  return (
    <section
      aria-labelledby="active-session-heading"
      className="space-y-3 rounded-2xl border border-accent/40 bg-accent-soft p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="active-session-heading" className="text-sm font-semibold">
          Session in progress
        </h2>
        <StatusBadge status={session.status} />
      </div>
      <p className="text-xs text-fg-muted">
        {session.selectedSurface
          ? `Sharing: ${session.selectedSurface.label}`
          : `Waiting for you to choose a ${CAPTURE_SOURCE_NOUN[session.options.source]}.`}
      </p>
      <Button variant="primary" fullWidth icon={ArrowUpRight} loading={opening} onClick={() => void openStudio()}>
        Open Recording Studio
      </Button>
    </section>
  );
}
