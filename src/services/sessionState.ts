import type { RecordingSession } from '@/types';

/**
 * The active recording session lives in `chrome.storage.session` so it survives service-worker
 * restarts but not browser restarts. The background service worker is the only writer; pages
 * read it and subscribe to changes, and send commands through `sendMessage()`.
 */
export const ACTIVE_SESSION_KEY = 'activeSession';

export async function readActiveSession(): Promise<RecordingSession | null> {
  const result = await chrome.storage.session.get(ACTIVE_SESSION_KEY);
  return (result[ACTIVE_SESSION_KEY] as RecordingSession | undefined) ?? null;
}

export function subscribeActiveSession(listener: (session: RecordingSession | null) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'session' && ACTIVE_SESSION_KEY in changes) {
      listener((changes[ACTIVE_SESSION_KEY]?.newValue as RecordingSession | undefined) ?? null);
    }
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
