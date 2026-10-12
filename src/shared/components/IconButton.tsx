import type { ButtonHTMLAttributes, Ref } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Tooltip, type TooltipProps } from './Tooltip';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  /** Accessible name; also shown as the tooltip. */
  label: string;
  size?: 'sm' | 'md';
  tone?: 'default' | 'danger';
  tooltipSide?: TooltipProps['side'];
  tooltipAlign?: TooltipProps['align'];
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  icon: Icon,
  label,
  size = 'md',
  tone = 'default',
  tooltipSide = 'top',
  tooltipAlign = 'center',
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip content={label} side={tooltipSide} align={tooltipAlign} describe={false}>
      <button
        type={type}
        aria-label={label}
        className={cn(
          'inline-flex items-center justify-center rounded-lg text-fg-muted transition-colors duration-150',
          'hover:bg-surface-3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50',
          tone === 'danger' && 'hover:bg-danger/12 hover:text-danger',
          size === 'sm' ? 'size-8' : 'size-9',
          className,
        )}
        {...rest}
      >
        <Icon size={size === 'sm' ? 15 : 18} aria-hidden />
      </button>
    </Tooltip>
  );
}
