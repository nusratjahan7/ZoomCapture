import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

export interface PanelProps {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  as?: 'section' | 'aside' | 'div';
}

/** Bordered surface with an optional heading row. */
export function Panel({ title, description, actions, children, className, as: Tag = 'section' }: PanelProps) {
  return (
    <Tag className={cn('rounded-2xl border border-line bg-surface p-4', className)}>
      {(title || actions) && (
        <header className="mb-3 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-tight text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-fg-subtle">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </Tag>
  );
}
