import { DEFAULT_SETTINGS, type UserSettings } from '@/types';

const SETTINGS_KEY = 'settings';

function withDefaults(stored: Partial<UserSettings> | undefined): UserSettings {
  // Nested groups merge key by key, so settings added in an update get their defaults.
  return { ...DEFAULT_SETTINGS, ...stored, autoZoom: { ...DEFAULT_SETTINGS.autoZoom, ...stored?.autoZoom } };
}

export async function getSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return withDefaults(result[SETTINGS_KEY] as Partial<UserSettings> | undefined);
}

export async function updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function resetSettings(): Promise<UserSettings> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  return DEFAULT_SETTINGS;
}

/** Fills in any settings keys missing from storage (e.g. after an update adds new settings). */
export async function ensureSettings(): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: await getSettings() });
}

/** Notifies on settings changes made from any extension context. Returns an unsubscribe function. */
export function subscribeSettings(listener: (settings: UserSettings) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && SETTINGS_KEY in changes) {
      listener(withDefaults(changes[SETTINGS_KEY]?.newValue as Partial<UserSettings> | undefined));
    }
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
