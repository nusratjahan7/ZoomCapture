import type { SessionStatus } from '@/types';
import { cn } from '@/utils/cn';

const STATUS: Record<SessionStatus, { label: string; dot: string; pulse?: boolean }> = {
  preparing: { label: 'Choose a source', dot: 'bg-warning' },
  'source-ready': { label: 'Source connected', dot: 'bg-success' },
  countdown: { label: 'Starting', dot: 'bg-warning', pulse: true },
  recording: { label: 'Recording', dot: 'bg-rec', pulse: true },
  paused: { label: 'Paused', dot: 'bg-warning' },
  finalizing: { label: 'Saving', dot: 'bg-accent-2', pulse: true },
  completed: { label: 'Completed', dot: 'bg-success' },
  cancelled: { label: 'Cancelled', dot: 'bg-fg-subtle' },
  error: { label: 'Error', dot: 'bg-danger' },
};

export function StatusBadge({ status, className }: { status: SessionStatus; className?: string }) {
  const { label, dot, pulse } = STATUS[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-fg-muted',
        className,
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', dot, pulse && 'animate-pulse')} />
      {label}
    </span>
  );
}
