import { useState } from 'react';
import { Info, Loader2, MousePointerClick, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Button, Panel } from '@/shared/components';
import { cn } from '@/utils/cn';
import type { TrackingStatus } from '../hooks/useClickTracking';

/**
 * Makes click tracking transparent: whether it runs, where, how many clicks were captured, and
 * why it is unavailable for the current source.
 */
export function ClickTrackingPanel({
  status,
  clicks,
  recording,
  autoZoomEnabled,
  onAllowOnSite,
}: {
  status: TrackingStatus;
  clicks: number;
  recording: boolean;
  autoZoomEnabled: boolean;
  onAllowOnSite: () => Promise<boolean>;
}) {
  const [requesting, setRequesting] = useState(false);
  const tone =
    status.state === 'active' ? 'text-success' : status.state === 'unsupported' ? 'text-fg-subtle' : 'text-warning';
  const Icon =
    status.state === 'active'
      ? MousePointerClick
      : status.state === 'connecting'
        ? Loader2
        : status.state === 'unsupported'
          ? Info
          : TriangleAlert;

  const title = {
    active: 'Tracking clicks',
    connecting: 'Connecting to the tab…',
    paused: 'Click tracking paused',
    unsupported: 'Clicks are not tracked',
    error: 'Click tracking stopped',
  }[status.state];

  return (
    <Panel title="Automatic zoom" description="Zoom effects are created at the places you click.">
      <div className="flex items-start gap-3" role="status" aria-live="polite">
        <span className={cn('mt-0.5 shrink-0', tone)}>
          <Icon size={18} aria-hidden className={status.state === 'connecting' ? 'animate-spin' : undefined} />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">{title}</p>
          {status.state === 'active' && (
            <p className="mt-0.5 text-xs text-fg-muted">
              In <span className="font-medium text-fg">{status.origin}</span>.{' '}
              {recording ? `${clicks} ${clicks === 1 ? 'click' : 'clicks'} captured.` : 'Clicks are captured once recording starts.'}
            </p>
          )}
          {'reason' in status && <p className="mt-0.5 text-xs text-fg-muted">{status.reason}</p>}
          {status.state === 'paused' && (
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              loading={requesting}
              onClick={() => {
                setRequesting(true);
                void onAllowOnSite().finally(() => setRequesting(false));
              }}
            >
              Always allow on {status.origin}
            </Button>
          )}
        </div>
      </div>
      {status.state !== 'unsupported' && (
        <p className="mt-3 flex gap-2 border-t border-line pt-3 text-xs text-fg-subtle">
          <ShieldCheck size={14} aria-hidden className="mt-0.5 shrink-0" />
          Only clicks and pointer positions in this tab are recorded, never page content or typing.
          {!autoZoomEnabled && ' Automatic zoom is off, so no effects are created; you can generate them later in the editor.'}
        </p>
      )}
    </Panel>
  );
}
