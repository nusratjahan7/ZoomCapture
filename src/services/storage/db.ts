import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { MediaAsset, Project } from '@/types';

export const DB_NAME = 'zoomcapture';
export const DB_VERSION = 1;

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
    },
    blocking() {
      // A newer version was opened in another extension page; release so it can upgrade.
      void dbPromise?.then((db) => db.close());
      dbPromise = undefined;
    },
  });
  return dbPromise;
}
