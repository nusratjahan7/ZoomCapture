import { useEffect, useState } from 'react';
import { readActiveSession, subscribeActiveSession } from '@/services/sessionState';
import type { RecordingSession } from '@/types';

/** The current recording session (or null), updated whenever the background changes it. */
export function useActiveSession() {
  const [session, setSession] = useState<RecordingSession | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void readActiveSession().then((value) => {
      if (!active) return;
      setSession(value);
      setLoaded(true);
    });
    const unsubscribe = subscribeActiveSession(setSession);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return { session, loaded };
}
