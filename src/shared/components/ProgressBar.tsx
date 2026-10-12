import { cn } from '@/utils/cn';

/** Determinate progress bar (0-1) with an accessible label. */
export function ProgressBar({ value, label, className }: { value: number; label: string; className?: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={cn('h-2 overflow-hidden rounded-full bg-surface-3', className)}
    >
      <div
        className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-300"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
