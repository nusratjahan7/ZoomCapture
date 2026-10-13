import { cloneElement, useEffect, useId, useState, type ReactElement } from 'react';
import { cn } from '@/utils/cn';

export interface TooltipProps {
  content: string;
  children: ReactElement<{ 'aria-describedby'?: string }>;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
  /**
   * When the tooltip repeats the trigger's accessible name (e.g. icon buttons), it is not
   * wired up as a description so screen readers do not announce it twice.
   */
  describe?: boolean;
}

const SIDE = { top: 'bottom-full mb-2', bottom: 'top-full mt-2' };
const ALIGN = { start: 'left-0', center: 'left-1/2 -translate-x-1/2', end: 'right-0' };

/** Accessible tooltip shown on hover and keyboard focus; dismissible with Escape. */
export function Tooltip({ content, children, side = 'top', align = 'center', describe = true }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {describe ? cloneElement(children, { 'aria-describedby': id }) : children}
      <span
        id={id}
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 whitespace-nowrap rounded-md border border-line-strong bg-surface-3 px-2 py-1',
          'text-xs font-medium text-fg shadow-elevated transition-opacity duration-100',
          SIDE[side],
          ALIGN[align],
          // Closed: not laid out at all, so a tooltip near the window edge can't widen the page
          // (a scrollbar). Still readable as a description while hidden.
          open ? 'block opacity-100' : 'hidden',
        )}
      >
        {content}
      </span>
    </span>
  );
}
