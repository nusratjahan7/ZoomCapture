import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { MediaAsset, Project, RecordingChunk, RecordingDraft } from '@/types';

export const DB_NAME = 'zoomcapture';
export const DB_VERSION = 2;

/**
 * Local project storage. Media blobs are kept in their own store so that listing projects
 * or asset metadata never loads video data into memory.
 */
export interface ZoomCaptureDB extends DBSchema {
  projects: {
    key: string;
    value: Project;
    indexes: { 'by-updated': number };
  };
  assets: {
    key: string;
    value: MediaAsset;
    indexes: { 'by-project': string };
  };
  assetBlobs: {
    key: string;
    value: Blob;
  };
  /** Recordings in progress or interrupted (see RecordingDraft). */
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

let dbPromise: Promise<IDBPDatabase<ZoomCaptureDB>> | undefined;

export function getDb(): Promise<IDBPDatabase<ZoomCaptureDB>> {
  dbPromise ??= openDB<ZoomCaptureDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // Each block migrates from one version to the next; add new blocks for future versions.
      if (oldVersion < 1) {
        const projects = db.createObjectStore('projects', { keyPath: 'id' });
        projects.createIndex('by-updated', 'updatedAt');
        const assets = db.createObjectStore('assets', { keyPath: 'id' });
        assets.createIndex('by-project', 'projectId');
        db.createObjectStore('assetBlobs');
      }
      if (oldVersion < 2) {
        db.createObjectStore('recordingDrafts', { keyPath: 'id' });
        db.createObjectStore('recordingChunks', { keyPath: ['draftId', 'trackId', 'seq'] });
      }
    },
    blocking() {
      // A newer version was opened in another extension page; release so it can upgrade.
      void dbPromise?.then((db) => db.close());
      dbPromise = undefined;
    },
  });
  return dbPromise;
}
