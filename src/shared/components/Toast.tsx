import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/utils/cn';

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismissal. Defaults to 4.5s (7s for errors). */
  duration?: number;
}

interface ToastItem extends Required<Pick<ToastOptions, 'title' | 'variant'>> {
  id: number;
  description?: string;
}

interface ToastContextValue {
  show: (options: ToastOptions) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS = { success: CheckCircle2, error: TriangleAlert, info: Info };
const ICON_COLORS = { success: 'text-success', error: 'text-danger', info: 'text-accent-2' };

export function ToastProvider({ children, placement = 'bottom-right' }: { children: ReactNode; placement?: 'bottom-right' | 'bottom-center' }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    ({ title, description, variant = 'info', duration }: ToastOptions) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { id, title, description, variant }]);
      window.setTimeout(() => dismiss(id), duration ?? (variant === 'error' ? 7000 : 4500));
    },
    [dismiss],
  );

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-label="Notifications"
        className={cn(
          'pointer-events-none fixed bottom-4 z-[60] flex w-[min(92vw,360px)] flex-col gap-2',
          placement === 'bottom-right' ? 'right-4' : 'left-1/2 -translate-x-1/2',
        )}
      >
        {toasts.map((toast) => {
          const Icon = ICONS[toast.variant];
          return (
            <div
              key={toast.id}
              role={toast.variant === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex animate-toast-in items-start gap-3 rounded-xl border border-line-strong bg-surface-2 p-3 shadow-elevated"
            >
              <Icon size={18} aria-hidden className={cn('mt-0.5 shrink-0', ICON_COLORS[toast.variant])} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">{toast.title}</p>
                {toast.description && <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{toast.description}</p>}
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismiss(toast.id)}
                className="-m-1 rounded-md p-1 text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg"
              >
                <X size={14} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>.');
  return context;
}
