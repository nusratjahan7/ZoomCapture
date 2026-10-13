import { useEffect, useId, useState, type ReactNode } from 'react';
import { cn } from '@/utils/cn';
import { formatTimecode, parseTimecode } from '../state/EditorContext';

/**
 * Small form fields for the properties panel. Text-like fields keep a local draft and commit on
 * Enter or when focus leaves (Escape reverts), so an edit is one undo step and half-typed values
 * are never applied. Invalid input is shown inline and not committed.
 */

const inputClass = (invalid: boolean) =>
  cn(
    'h-8 w-full rounded-lg border bg-surface-2 px-2 text-sm text-fg tabular-nums transition-colors',
    invalid ? 'border-danger' : 'border-line-strong hover:border-fg-subtle',
  );

export function FieldRow({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2">
      <label htmlFor={htmlFor} className="text-xs text-fg-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

function DraftField({
  label,
  value,
  format,
  parse,
  onCommit,
  hint,
}: {
  label: string;
  value: number;
  format: (value: number) => string;
  parse: (text: string) => number | null;
  onCommit: (value: number) => void;
  hint?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(format(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(format(value));
    setInvalid(false);
  }, [value]);

  const commit = () => {
    const parsed = parse(draft);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed !== value) onCommit(parsed);
    else setDraft(format(value));
  };

  return (
    <FieldRow label={label} htmlFor={id}>
      <div>
        <input
          id={id}
          value={draft}
          inputMode="decimal"
          aria-invalid={invalid || undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') {
              setDraft(format(value));
              setInvalid(false);
            }
          }}
          className={inputClass(invalid)}
        />
        {invalid && <p className="mt-1 text-[11px] text-danger">{hint ?? 'Enter a valid value.'}</p>}
      </div>
    </FieldRow>
  );
}

/** A time in m:ss.xx (milliseconds internally). */
export function TimeField(props: { label: string; value: number; onCommit: (ms: number) => void; min?: number }) {
  return (
    <DraftField
      label={props.label}
      value={props.value}
      format={formatTimecode}
      parse={(text) => {
        const ms = parseTimecode(text);
        return ms === null || ms < (props.min ?? 0) ? null : ms;
      }}
      onCommit={props.onCommit}
      hint="Use m:ss.xx, e.g. 0:04.50"
    />
  );
}

/** A number with optional unit conversion (e.g. seconds shown, milliseconds stored). */
export function NumberField(props: { label: string; value: number; min: number; max: number; scale?: number; decimals?: number; unit?: string; onCommit: (value: number) => void }) {
  const scale = props.scale ?? 1;
  const decimals = props.decimals ?? 1;
  return (
    <DraftField
      label={props.unit ? `${props.label} (${props.unit})` : props.label}
      value={props.value}
      format={(value) => (value / scale).toFixed(decimals)}
      parse={(text) => {
        const number = Number(text.replace(',', '.'));
        if (text.trim() === '' || !Number.isFinite(number)) return null;
        const stored = number * scale;
        return stored < props.min || stored > props.max ? null : stored;
      }}
      onCommit={props.onCommit}
      hint={`Between ${(props.min / scale).toFixed(decimals)} and ${(props.max / scale).toFixed(decimals)}.`}
    />
  );
}

/** A slider that commits continuously (callers merge the edits into one undo step). */
export function SliderField(props: { label: string; value: number; min: number; max: number; step: number; display: (value: number) => string; onChange: (value: number) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <FieldRow label={props.label} htmlFor={id}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="range"
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value}
          disabled={props.disabled}
          onChange={(event) => props.onChange(Number(event.target.value))}
          className="min-w-0 flex-1 accent-[var(--color-accent)]"
        />
        <output htmlFor={id} className="w-12 text-right font-mono text-xs text-fg-muted">
          {props.display(props.value)}
        </output>
      </div>
    </FieldRow>
  );
}
