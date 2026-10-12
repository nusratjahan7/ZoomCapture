import { useId } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface ToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  description?: string;
  icon?: LucideIcon;
  disabled?: boolean;
  /** `card` renders a bordered tile (popup quick toggles); `row` renders a plain list row. */
  appearance?: 'card' | 'row';
  className?: string;
}

/** Accessible switch. The whole row is the control, so it is easy to hit with mouse or touch. */
export function Toggle({
  checked,
  onCheckedChange,
  label,
  description,
  icon: Icon,
  disabled,
  appearance = 'row',
  className,
}: ToggleProps) {
  const labelId = useId();
  const descriptionId = useId();

  const track = (
    <span
      aria-hidden
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150',
        checked ? 'bg-accent' : 'bg-line-strong',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform duration-150',
          checked && 'translate-x-4',
        )}
      />
    </span>
  );

  const iconBadge = Icon && (
    <span
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
        checked ? 'bg-accent/20 text-accent-hover' : 'bg-surface-3 text-fg-muted',
      )}
    >
      <Icon size={16} aria-hidden />
    </span>
  );

  const text = (
    <span className="min-w-0 flex-1">
      <span id={labelId} className="block truncate text-sm font-medium text-fg">
        {label}
      </span>
      {description && (
        <span id={descriptionId} className="block truncate text-xs text-fg-subtle">
          {description}
        </span>
      )}
    </span>
  );

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={description ? descriptionId : undefined}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'w-full text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        appearance === 'card'
          ? cn(
              'flex flex-col gap-2.5 rounded-xl border p-3',
              checked ? 'border-accent/50 bg-accent-soft' : 'border-line bg-surface-2 hover:border-line-strong',
            )
          : 'flex items-center gap-3 rounded-lg px-1 py-2',
        className,
      )}
    >
      {appearance === 'card' ? (
        <>
          <span className="flex items-center justify-between">
            {iconBadge}
            {track}
          </span>
          {text}
        </>
      ) : (
        <>
          {iconBadge}
          {text}
          {track}
        </>
      )}
    </button>
  );
}
