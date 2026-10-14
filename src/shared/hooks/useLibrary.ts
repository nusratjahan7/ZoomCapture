import { useCallback, useEffect, useState } from 'react';
import { subscribeLibrary } from '@/services/storage/libraryEvents';
import { listLibrary, type LibraryEntry } from '@/services/storage/libraryRepository';
import { describeStorageError } from '@/utils/storageErrors';

/**
 * Every recording with its project (metadata only), newest first. Refreshes when another page
 * changes the library and when this page becomes visible again.
 */
export function useLibrary() {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setEntries(await listLibrary());
      setError(null);
    } catch (err) {
      setError(describeStorageError(err));
    } finally {
      setLoading(false);
    }
  }, []);

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

  return { entries, loading, error, refresh };
}
