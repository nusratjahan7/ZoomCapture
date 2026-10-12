import type { ButtonHTMLAttributes, Ref } from 'react';
import { Loader2, type LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'record';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  loading?: boolean;
  fullWidth?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover shadow-[0_8px_24px_-10px] shadow-accent/70',
  secondary: 'bg-surface-3 text-fg border border-line-strong hover:bg-line',
  ghost: 'text-fg-muted hover:text-fg hover:bg-surface-3',
  danger: 'bg-danger/12 text-danger border border-danger/30 hover:bg-danger/20',
  record:
    'bg-rec text-white hover:bg-rec-hover shadow-[0_10px_30px_-10px] shadow-rec/80 font-semibold tracking-tight',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-5 text-[15px] gap-2.5 rounded-xl',
};

const ICON_SIZES: Record<ButtonSize, number> = { sm: 14, md: 16, lg: 18 };

/** Button styling for elements that must be links (e.g. in-page navigation). */
export function buttonClassName({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
}: { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean } = {}): string {
  return cn(
    'inline-flex shrink-0 select-none items-center justify-center font-medium transition-colors duration-150',
    'disabled:cursor-not-allowed disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
    fullWidth && 'w-full',
  );
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  loading = false,
  fullWidth = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonClassName({ variant, size, fullWidth }), className)}
      {...rest}
    >
      {loading ? (
        <Loader2 size={ICON_SIZES[size]} className="animate-spin" aria-hidden />
      ) : (
        Icon && <Icon size={ICON_SIZES[size]} aria-hidden />
      )}
      {children}
    </button>
  );
}
