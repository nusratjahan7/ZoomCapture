import { useCallback, useEffect, useState } from 'react';

/** Copies this page's styles into the Picture-in-Picture document so shared components render the same. */
function copyStyles(target: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = target.createElement('style');
      style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
      target.head.append(style);
    } catch {
      if (!sheet.href) continue;
      const link = target.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      target.head.append(link);
    }
  }
  target.documentElement.style.colorScheme = 'dark';
  target.body.className = 'bg-canvas text-fg antialiased overflow-hidden';
}

/**
 * Document Picture-in-Picture: an always-on-top window the user can move anywhere, even over
 * other apps. Opening it requires a user gesture, so `open()` must be called from a click handler.
 */
export function useDocumentPip() {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const supported = typeof window.documentPictureInPicture?.requestWindow === 'function';

  const open = useCallback(async (size: { width: number; height: number }) => {
    const api = window.documentPictureInPicture;
    if (!api) return null;
    if (api.window) return api.window;
    const pip = await api.requestWindow(size);
    pip.document.title = 'ZoomCapture';
    copyStyles(pip.document);
    pip.addEventListener('pagehide', () => setPipWindow(null), { once: true });
    setPipWindow(pip);
    return pip;
  }, []);

  const close = useCallback(() => {
    window.documentPictureInPicture?.window?.close();
    setPipWindow(null);
  }, []);

  // Never leave a floating window behind when the studio goes away.
  useEffect(() => () => window.documentPictureInPicture?.window?.close(), []);

  return { supported, pipWindow, open, close };
}
