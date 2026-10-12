import { useId, type InputHTMLAttributes, type Ref } from 'react';
import { cn } from '@/utils/cn';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: string;
  error?: string | null;
  onValueChange: (value: string) => void;
  ref?: Ref<HTMLInputElement>;
}

/** Labelled text input with an accessible inline error. */
export function TextField({ label, error, onValueChange, className, ...rest }: TextFieldProps) {
  const id = useId();
  const errorId = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onValueChange(event.target.value)}
        className={cn(
          'mt-2 h-10 w-full rounded-xl border bg-surface-2 px-3 text-sm text-fg transition-colors',
          'placeholder:text-fg-subtle focus-visible:outline-offset-0',
          error ? 'border-danger' : 'border-line-strong hover:border-fg-subtle',
        )}
        {...rest}
      />
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
