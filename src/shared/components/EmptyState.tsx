import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, compact, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center text-center', compact ? 'gap-2 py-5' : 'gap-3 py-12', className)}>
      <span
        className={cn(
          'flex items-center justify-center rounded-2xl border border-line bg-surface-2 text-fg-subtle',
          compact ? 'size-10' : 'size-14',
        )}
      >
        <Icon size={compact ? 18 : 24} aria-hidden />
      </span>
      <div>
        <p className={cn('font-medium text-fg', compact ? 'text-sm' : 'text-base')}>{title}</p>
        {description && (
          <p className={cn('mx-auto mt-1 max-w-sm text-fg-subtle', compact ? 'text-xs' : 'text-sm')}>{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
