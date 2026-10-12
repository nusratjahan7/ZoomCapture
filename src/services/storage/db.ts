import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import type { MediaAsset, Project, Recording, RecordingChunk, RecordingDraft } from '@/types';
import { runMigrations } from './migrations';

export const DB_NAME = 'zoomcapture';
/** Bump together with a new step in `migrations.ts`. */
export const DB_VERSION = 3;

/**
 * Local storage for recordings. Small records (recordings, projects, asset metadata, drafts)
 * are separate from media bytes (`assetBlobs`, `recordingChunks`), so listing never loads video.
 * Nothing here is synced to the cloud: chrome.storage.sync is never used for media.
 */
export interface ZoomCaptureDB extends DBSchema {
  recordings: {
    key: string;
    value: Recording;
    indexes: { 'by-created': number };
  };
  projects: {
    key: string;
    value: Project;
    indexes: { 'by-updated': number; 'by-recording': string };
  };
  assets: {
    key: string;
    value: MediaAsset;
    indexes: { 'by-project': string; 'by-recording': string };
  };
  assetBlobs: {
    key: string;
    value: Blob;
  };
  /** Recordings in progress, interrupted, or partway through saving (see RecordingDraft). */
  recordingDrafts: {
    key: string;
    value: RecordingDraft;
  };
  /** Media chunks keyed by [draftId, trackId, seq] so a track reads back in order with one range. */
  recordingChunks: {
    key: [string, string, number];
    value: RecordingChunk;
  };
}

export type ZoomCaptureDatabase = IDBPDatabase<ZoomCaptureDB>;

let dbPromise: Promise<ZoomCaptureDatabase> | undefined;

export function getDb(): Promise<ZoomCaptureDatabase> {
  dbPromise ??= openDB<ZoomCaptureDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      return runMigrations(db, oldVersion, transaction);
    },
    blocking() {
      // A newer version was opened in another extension page; release so it can upgrade.
      void closeDb();
    },
    terminated() {
      // The browser closed the connection (e.g. storage cleared); reopen on next use.
      dbPromise = undefined;
    },
  }).catch((error: unknown) => {
    dbPromise = undefined;
    throw error;
  });
  return dbPromise;
}

/**
 * Runs `body` inside one transaction and waits for it to commit. If `body` throws (including a
 * synchronous error from a request), the transaction is aborted, so it never commits partially.
 */
export async function withTransaction<Names extends StoreNames<ZoomCaptureDB>, Mode extends IDBTransactionMode, T>(
  storeNames: Names[],
  mode: Mode,
  body: (tx: IDBPTransaction<ZoomCaptureDB, Names[], Mode>) => Promise<T>,
): Promise<T> {
  const db = await getDb();
  const tx = db.transaction(storeNames, mode);
  try {
    const result = await body(tx);
    await tx.done;
    return result;
  } catch (error) {
    tx.done.catch(() => undefined); // aborting rejects `done`; the original error is what matters
    try {
      tx.abort();
    } catch {
      // Already finished or aborted by the browser.
    }
    throw error;
  }
}

/** Closes the shared connection (next `getDb()` reopens it). */
export async function closeDb(): Promise<void> {
  const pending = dbPromise;
  dbPromise = undefined;
  (await pending?.catch(() => undefined))?.close();
}
