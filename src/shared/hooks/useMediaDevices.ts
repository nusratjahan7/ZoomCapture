import { useCallback, useEffect, useState } from 'react';
import { grantDeviceAccess, listMediaDevices, type MediaDeviceInventory } from '@/services/media/userMedia';

/** Available cameras and microphones, refreshed when devices are plugged in or removed. */
export function useMediaDevices() {
  const [inventory, setInventory] = useState<MediaDeviceInventory | null>(null);

  const refresh = useCallback(async () => setInventory(await listMediaDevices()), []);

  useEffect(() => {
    void refresh();
    // Rechecked when devices change and when the page is shown again (permissions may have
    // changed in Chrome meanwhile): availability is never assumed from an earlier check.
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const requestAccess = useCallback(async () => {
    await grantDeviceAccess();
    await refresh();
  }, [refresh]);

  return { inventory, requestAccess, refresh };
}
