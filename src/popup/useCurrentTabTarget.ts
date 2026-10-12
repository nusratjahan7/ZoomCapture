import { useEffect, useState } from 'react';
import { isTrackableUrl } from '@/services/zoom/support';
import type { CaptureTarget } from '@/types';

/**
 * The tab the popup was opened on. Opening the popup grants `activeTab` for it, so its URL and
 * title are readable without the `tabs` permission, and ZoomCapture may capture it directly and
 * track clicks in it. Null for pages where Chrome forbids extensions (browser pages, Web Store).
 */
export function useCurrentTabTarget(): { target: CaptureTarget | null; loaded: boolean } {
  const [state, setState] = useState<{ target: CaptureTarget | null; loaded: boolean }>({ target: null, loaded: false });

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(
      ([tab]) => {
        if (tab?.id === undefined || !isTrackableUrl(tab.url)) return setState({ target: null, loaded: true });
        setState({ target: { tabId: tab.id, title: tab.title ?? '', origin: new URL(tab.url!).origin }, loaded: true });
      },
      () => setState({ target: null, loaded: true }),
    );
  }, []);

  return state;
}
