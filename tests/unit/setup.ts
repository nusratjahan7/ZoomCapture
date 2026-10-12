import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, vi } from 'vitest';
import { closeDb } from '@/services/storage/db';

// Every test starts with an empty, independent IndexedDB.
beforeEach(async () => {
  await closeDb();
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  vi.restoreAllMocks();
});
