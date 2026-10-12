import { getErrorMessage } from './errors';

/** Thrown (or recognised) when the browser refuses to store more data. */
export class StorageFullError extends Error {
  constructor(cause?: unknown) {
    super('Your device is out of storage space for ZoomCapture.', { cause });
    this.name = 'StorageFullError';
  }
}

function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : undefined;
}

/**
 * True for quota failures, however they surface: a QuotaExceededError from a request, or a
 * transaction aborted because of one (`AbortError` whose `cause`/`error` is the quota error).
 */
export function isQuotaError(error: unknown): boolean {
  if (error instanceof StorageFullError) return true;
  const name = errorName(error);
  if (name === 'QuotaExceededError') return true;
  if (typeof error === 'object' && error !== null) {
    const nested = (error as { cause?: unknown; error?: unknown }).cause ?? (error as { error?: unknown }).error;
    if (nested && nested !== error) return isQuotaError(nested);
  }
  return /quota|disk is full|no space/i.test(getErrorMessage(error));
}

/** User-facing explanation for a storage failure, including what to do next. */
export function describeStorageError(error: unknown): string {
  if (isQuotaError(error)) {
    return 'There is not enough free disk space to save the recording. Nothing was deleted: free up space on your device (or delete recordings you no longer need), then retry.';
  }
  if (errorName(error) === 'VersionError') {
    return 'The recording library was upgraded by a newer version of ZoomCapture. Reload this page.';
  }
  return `The recording could not be saved: ${getErrorMessage(error)} Nothing was deleted; you can retry.`;
}
