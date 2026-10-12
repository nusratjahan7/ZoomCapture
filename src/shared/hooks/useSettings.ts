import { useCallback, useEffect, useState } from 'react';
import { getSettings, subscribeSettings, updateSettings } from '@/services/settings';
import type { UserSettings } from '@/types';

/** Live view of user settings, kept in sync across every open extension page. */
export function useSettings() {
  const [settings, setSettings] = useState<UserSettings | null>(null);

  useEffect(() => {
    let active = true;
    void getSettings().then((value) => active && setSettings(value));
    const unsubscribe = subscribeSettings(setSettings);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const update = useCallback(async (patch: Partial<UserSettings>) => {
    setSettings((current) => (current ? { ...current, ...patch } : current));
    return updateSettings(patch);
  }, []);

  return { settings, update };
}
