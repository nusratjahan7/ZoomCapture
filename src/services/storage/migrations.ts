import type { IDBPDatabase, IDBPTransaction, StoreNames } from 'idb';
import type { MediaAsset, Project, Recording } from '@/types';
import { createId } from '@/utils/id';
import type { ZoomCaptureDB } from './db';
import { defaultExportSettings, defaultZoomSettings } from './projectDefaults';

type UpgradeTransaction = IDBPTransaction<ZoomCaptureDB, StoreNames<ZoomCaptureDB>[], 'versionchange'>;

/**
 * Schema history. Each step upgrades from the previous version and must never be edited once
 * shipped; add a new step instead. Steps run inside the single `versionchange` transaction, so an
 * upgrade either completes fully or leaves the old database untouched.
 *
 * v1: projects, assets, assetBlobs                 (Module 01)
 * v2: recordingDrafts, recordingChunks             (Module 02)
 * v3: recordings split from editable projects      (Module 03)
 */
export async function runMigrations(
  db: IDBPDatabase<ZoomCaptureDB>,
  oldVersion: number,
  transaction: UpgradeTransaction,
): Promise<void> {
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
  if (oldVersion < 3) {
    await migrateToV3(db, transaction);
  }
}

/** Shape of a v2 project, which mixed recording facts with editable data. */
interface ProjectV2 {
  id: string;
  name: string;
  sessionId?: string;
  timeline: Project['timeline'];
  interactions?: Project['interactions'];
  cameraLayout?: Project['cameraLayout'];
  source?: Recording['source'];
  createdAt: number;
  updatedAt: number;
}

type AssetV2 = Omit<MediaAsset, 'origin' | 'recordingId'> & { projectId: string };

async function migrateToV3(db: IDBPDatabase<ZoomCaptureDB>, transaction: UpgradeTransaction): Promise<void> {
  const recordings = db.createObjectStore('recordings', { keyPath: 'id' });
  recordings.createIndex('by-created', 'createdAt');
  transaction.objectStore('projects').createIndex('by-recording', 'recordingId');
  const assetStore = transaction.objectStore('assets');
  assetStore.createIndex('by-recording', 'recordingId');

  // Every v2 project was one recording: split it into a Recording and an editable Project.
  const oldProjects = (await transaction.objectStore('projects').getAll()) as unknown as ProjectV2[];
  for (const old of oldProjects) {
    const assets = (await assetStore.index('by-project').getAll(old.id)) as unknown as AssetV2[];
    const screen = assets.find((asset) => asset.kind === 'screen');
    if (!screen) continue; // nothing playable; leave the data untouched rather than guess

    const recordingId = createId('rec');
    for (const asset of assets) {
      const { projectId: _owner, ...rest } = asset;
      await assetStore.put({ ...rest, origin: 'recording', recordingId });
    }
    await recordings.add({
      id: recordingId,
      name: old.name,
      projectId: old.id,
      sessionId: old.sessionId,
      durationMs: old.timeline.durationMs,
      sizeBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
      mimeType: screen.mimeType,
      width: screen.width,
      height: screen.height,
      source: old.source,
      screenAssetId: screen.id,
      assetIds: assets.map((asset) => asset.id),
      createdAt: old.createdAt,
      updatedAt: old.updatedAt,
    });
    await transaction.objectStore('projects').put(upgradeProject(old, recordingId));
  }
}

function upgradeProject(old: ProjectV2, recordingId: string): Project {
  return {
    id: old.id,
    recordingId,
    schemaVersion: 1,
    timeline: old.timeline,
    zoom: defaultZoomSettings(),
    interactions: old.interactions ?? [],
    cameraLayout: old.cameraLayout,
    subtitles: [],
    importedAssetIds: [],
    exportSettings: defaultExportSettings(),
    createdAt: old.createdAt,
    updatedAt: old.updatedAt,
  };
}
