import { describe, expect, it } from 'vitest';
import { describeStorageError, isQuotaError, StorageFullError } from '@/utils/storageErrors';

describe('storage error handling', () => {
  it('recognises quota failures however they surface', () => {
    expect(isQuotaError(new DOMException('full', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaError(new StorageFullError())).toBe(true);
    // A transaction aborted because one of its requests hit the quota.
    expect(isQuotaError({ name: 'AbortError', error: new DOMException('full', 'QuotaExceededError') })).toBe(true);
    expect(isQuotaError(new Error('wrapper', { cause: new DOMException('full', 'QuotaExceededError') }))).toBe(true);
    expect(isQuotaError(new Error('Disk is full'))).toBe(true);
  });

  it('does not mistake other failures for a full disk', () => {
    expect(isQuotaError(new DOMException('x', 'ConstraintError'))).toBe(false);
    expect(isQuotaError(new Error('network'))).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });

  it('explains what to do and promises nothing was deleted', () => {
    const full = describeStorageError(new DOMException('full', 'QuotaExceededError'));
    expect(full).toMatch(/not enough free disk space/i);
    expect(full).toMatch(/Nothing was deleted/);
    expect(describeStorageError(new Error('boom'))).toMatch(/boom.*Nothing was deleted; you can retry/);
    expect(describeStorageError(new DOMException('newer', 'VersionError'))).toMatch(/Reload this page/);
  });
});
