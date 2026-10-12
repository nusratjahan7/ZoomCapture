import type { ReactNode } from 'react';
import { Settings } from 'lucide-react';
import { sendMessage } from '@/services/messaging';
import { IconButton, Logo } from '@/shared/components';

export function EditorHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-line bg-canvas/85 px-6 py-3 backdrop-blur">
      <a href="index.html" className="rounded-lg" aria-label="ZoomCapture project library">
        <Logo subtitle="Editor" />
      </a>
      <div className="ml-auto flex items-center gap-2">
        {children}
        <IconButton
          icon={Settings}
          label="Open settings"
          tooltipSide="bottom"
          tooltipAlign="end"
          onClick={() => void sendMessage('page/open', { page: 'settings' })}
        />
      </div>
    </header>
  );
}
