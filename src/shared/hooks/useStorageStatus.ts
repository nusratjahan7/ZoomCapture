import { useCallback, useEffect, useState } from 'react';
import { subscribeLibrary } from '@/services/storage/libraryEvents';
import { getStorageStatus, LOW_SPACE_BYTES, type StorageStatus } from '@/services/storage/storageStatus';

/** Browser storage use and space left, refreshed when the library changes or the page is shown. */
export function useStorageStatus() {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const refresh = useCallback(() => getStorageStatus().then(setStatus, () => setStatus({ persisted: null })), []);
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
  const free = status?.usage !== undefined && status.quota !== undefined ? Math.max(0, status.quota - status.usage) : undefined;
  return { status, free, low: free !== undefined && free < LOW_SPACE_BYTES, refresh };
}
