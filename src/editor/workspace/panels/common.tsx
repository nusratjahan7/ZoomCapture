import { useId, type ReactNode } from 'react';
import type { FontChoice } from '@/types';
import { cn } from '@/utils/cn';
import { FieldRow } from '../fields';

/** A panel section with a heading. */
export function PanelSection({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="space-y-3 border-b border-line p-3 last:border-b-0">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-fg-subtle uppercase">{title}</h3>
        {actions}
      </header>
      {children}
    </section>
  );
}

/** A colour picker in a field row. */
export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id}>
      <input id={id} type="color" value={toHex(value)} onChange={(event) => onChange(event.target.value)} className="h-8 w-16 cursor-pointer rounded border border-line-strong bg-surface-2" />
    </FieldRow>
  );
}

/** Wrapping buttons for choices with more options than fit a segmented control. */
export function ChoiceGrid<T extends string>({
  label,
  options,
  value,
  onChange,
  columns = 3,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  columns?: number;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-1" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'truncate rounded-lg border px-1.5 py-1.5 text-xs',
            value === option.value ? 'border-accent bg-accent/15 text-fg' : 'border-line bg-surface-2 text-fg-muted hover:text-fg',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export const FONT_OPTIONS: ReadonlyArray<{ value: FontChoice; label: string }> = [
  { value: 'system', label: 'Sans' },
  { value: 'serif', label: 'Serif' },
  { value: 'mono', label: 'Mono' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'condensed', label: 'Narrow' },
];

/** `<input type=color>` only takes #rrggbb. */
function toHex(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{3}$/i.test(value)) return `#${[...value.slice(1)].map((c) => c + c).join('')}`;
  const rgb = value.match(/\d+/g);
  if (rgb && rgb.length >= 3) return `#${rgb.slice(0, 3).map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`;
  return '#ffffff';
}

export const percent = (value: number) => `${Math.round(value * 100)} %`;
