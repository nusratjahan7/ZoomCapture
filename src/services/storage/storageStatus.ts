/** Warn before recording when less than this much space is left. */
export const LOW_SPACE_BYTES = 1024 ** 3;

export interface StorageStatus {
  usage?: number;
  quota?: number;
  /** Whether the browser will keep this data under storage pressure (null = unknown). */
  persisted: boolean | null;
}

export async function getStorageStatus(): Promise<StorageStatus> {
  const [estimate, persisted] = await Promise.all([
    navigator.storage?.estimate?.().catch(() => undefined),
    navigator.storage?.persisted?.().catch(() => null) ?? Promise.resolve(null),
  ]);
  return { usage: estimate?.usage, quota: estimate?.quota, persisted };
}

/**
 * Asks the browser to never evict ZoomCapture's data automatically. Extensions with the
 * `unlimitedStorage` permission are normally granted this without a prompt.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Free space as reported by the browser, or undefined if unknown. */
export async function availableSpace(): Promise<number | undefined> {
  const { usage, quota } = await getStorageStatus();
  return usage !== undefined && quota !== undefined ? Math.max(0, quota - usage) : undefined;
}
