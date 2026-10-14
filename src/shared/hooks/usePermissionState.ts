import { useEffect, useState } from 'react';

export type DevicePermission = 'granted' | 'denied' | 'prompt' | 'unknown';

/**
 * Chrome's current camera / microphone permission for this extension, read from the browser each
 * time (never stored: only Chrome can grant or revoke it). Rechecked when it changes, and when the
 * page is shown again (the user may have changed it in Chrome's site settings meanwhile).
 */
export function usePermissionState(name: 'camera' | 'microphone'): DevicePermission {
  const [state, setState] = useState<DevicePermission>('unknown');
  useEffect(() => {
    let status: PermissionStatus | null = null;
    let active = true;
    const read = async () => {
      try {
        status ??= await navigator.permissions.query({ name: name as PermissionName });
        if (active) setState(status.state);
        status.onchange = () => active && setState(status!.state);
      } catch {
        if (active) setState('unknown');
      }
    };
    void read();
    const onVisible = () => document.visibilityState === 'visible' && void read();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      active = false;
      if (status) status.onchange = null;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [name]);
  return state;
}
