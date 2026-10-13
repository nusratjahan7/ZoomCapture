import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuState {
  x: number;
  y: number;
  items: Array<MenuItem | 'separator'>;
  label: string;
}

/**
 * A right-click menu for timeline items. Opens at the pointer (kept inside the window), takes
 * focus, and closes on Escape, a click outside, scrolling or choosing an item. Arrow keys move
 * between items.
 */
export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!menu || !element) return setPosition(null);
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - height - 8)),
    });
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const close = () => onClose();
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('blur', close);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === 'ArrowDown') next = buttons[(index + 1) % buttons.length];
    else if (event.key === 'ArrowUp') next = buttons[(index - 1 + buttons.length) % buttons.length];
    else if (event.key === 'Home') next = buttons[0];
    else if (event.key === 'End') next = buttons.at(-1);
    else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    next?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={menu.label}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-50 min-w-48 rounded-xl border border-line-strong bg-surface-2 p-1 shadow-2xl"
      style={position ?? { left: menu.x, top: menu.y, visibility: 'hidden' }}
    >
      {menu.items.map((item, index) =>
        item === 'separator' ? (
          <div key={`sep-${index}`} role="separator" className="my-1 h-px bg-line" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none disabled:opacity-40',
              item.danger ? 'text-danger hover:bg-danger/10 focus-visible:bg-danger/10' : 'text-fg hover:bg-surface-3 focus-visible:bg-surface-3',
            )}
          >
            {item.icon && <item.icon size={14} aria-hidden className="shrink-0 opacity-80" />}
            <span className="flex-1">{item.label}</span>
            {item.shortcut && <kbd className="font-mono text-[11px] text-fg-subtle">{item.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
