import { useCallback, useEffect, useState } from 'react';
import { grantDeviceAccess, listMediaDevices, type MediaDeviceInventory } from '@/services/media/userMedia';

/** Available cameras and microphones, refreshed when devices are plugged in or removed. */
export function useMediaDevices() {
  const [inventory, setInventory] = useState<MediaDeviceInventory | null>(null);

  const refresh = useCallback(async () => setInventory(await listMediaDevices()), []);

  useEffect(() => {
    void refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, [refresh]);

  const requestAccess = useCallback(async () => {
    await grantDeviceAccess();
    await refresh();
  }, [refresh]);

  return { inventory, requestAccess };
}
