import { useId, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  label: string;
  description?: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
}

/** Labelled native select (keeps full keyboard and screen-reader support). */
export function Select({ label, description, options, onValueChange, className, ...rest }: SelectProps) {
  const id = useId();
  const descriptionId = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
      </label>
      {description && (
        <p id={descriptionId} className="mt-0.5 text-xs text-fg-subtle">
          {description}
        </p>
      )}
      <div className="relative mt-2">
        <select
          id={id}
          aria-describedby={description ? descriptionId : undefined}
          onChange={(event) => onValueChange(event.target.value)}
          className={cn(
            'h-10 w-full appearance-none rounded-xl border border-line-strong bg-surface-2 pr-9 pl-3 text-sm text-fg',
            'transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50',
          )}
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} className="bg-surface-2">
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          size={16}
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-fg-subtle"
        />
      </div>
    </div>
  );
}
