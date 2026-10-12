import { useCallback, useEffect, useState } from 'react';
import { subscribeLibrary } from '@/services/storage/libraryEvents';
import { listRecordings } from '@/services/storage/recordingRepository';
import type { Recording } from '@/types';
import { describeStorageError } from '@/utils/storageErrors';

/**
 * Saved recordings from IndexedDB, newest first. Refreshes when another page changes the library
 * and when this page becomes visible again.
 */
export function useRecordings(limit?: number) {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRecordings(await listRecordings(limit));
      setError(null);
    } catch (err) {
      setError(describeStorageError(err));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void refresh();
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    const unsubscribe = subscribeLibrary(() => void refresh());
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribe();
    };
  }, [refresh]);

  return { recordings, loading, error, refresh };
}
