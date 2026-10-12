import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Button } from './Button';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** `lg` fits media previews. */
  size?: 'md' | 'lg';
  className?: string;
}

/**
 * Modal dialog built on the native `<dialog>` element, which provides focus trapping,
 * Escape-to-close, inert background and top-layer rendering. Clicking the backdrop closes it.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'm-auto rounded-2xl border border-line-strong bg-surface p-0 text-fg shadow-elevated',
        'open:animate-fade-in',
        size === 'lg' ? 'w-[min(94vw,960px)]' : 'w-[min(92vw,420px)]',
        className,
      )}
    >
      <div className="p-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold tracking-tight">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-1.5 text-sm leading-relaxed text-fg-muted">
                {description}
              </p>
            )}
          </div>
          {/* Plain button: a tooltip would be clipped by the dialog and shown on initial focus. */}
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            className="-mt-1 -mr-1 inline-flex size-8 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg"
          >
            <X size={15} aria-hidden />
          </button>
        </div>
        {children && <div className="mt-4">{children}</div>}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  title: string;
  description: string;
  confirmLabel: string;
  tone?: 'default' | 'danger';
}

/** Confirmation dialog that shows a loading state while `onConfirm` runs. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  tone = 'default',
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={title}
      description={description}
      footer={
        <>
          {/* Initial focus on the safe choice. */}
          <Button variant="ghost" onClick={onClose} disabled={busy} autoFocus>
            Cancel
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={() => void confirm()} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
