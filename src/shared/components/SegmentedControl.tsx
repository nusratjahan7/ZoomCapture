import { useRef, type KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface SegmentOption<T extends string | number> {
  value: T;
  label: string;
  /** Used by the compact `inline` appearance when the full label would wrap. */
  shortLabel?: string;
  icon?: LucideIcon;
}

export interface SegmentedControlProps<T extends string | number> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the radio group. */
  label: string;
  disabled?: boolean;
  /** `tiles` stacks icon over label (popup source picker); `inline` is a compact pill bar. */
  appearance?: 'tiles' | 'inline';
  className?: string;
}

/** Radio group with roving focus: Tab enters the group, arrow keys move and select. */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  label,
  disabled,
  appearance = 'inline',
  className,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const next = (selectedIndex + delta + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        'grid gap-1 rounded-xl border border-line bg-surface-2 p-1',
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        const Icon = option.icon;
        return (
          <button
            key={String(option.value)}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex items-center justify-center rounded-lg font-medium transition-colors duration-150',
              'disabled:cursor-not-allowed disabled:opacity-50',
              appearance === 'tiles' ? 'flex-col gap-1.5 py-2.5 text-xs' : 'h-8 gap-1.5 px-2 text-xs whitespace-nowrap',
              selected
                ? 'bg-surface-3 text-fg shadow-[inset_0_0_0_1px] shadow-line-strong'
                : 'text-fg-muted hover:text-fg',
            )}
          >
            {Icon && (
              <Icon size={appearance === 'tiles' ? 18 : 14} aria-hidden className={cn(selected && 'text-accent-2')} />
            )}
            {appearance === 'inline' ? (option.shortLabel ?? option.label) : option.label}
          </button>
        );
      })}
    </div>
  );
}
