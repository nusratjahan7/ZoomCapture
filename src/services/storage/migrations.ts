import type { IDBPDatabase, IDBPTransaction, StoreNames } from 'idb';
import type { InteractionEvent, MediaAsset, Project, Recording, ZoomMarker } from '@/types';
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
 * v4: click interactions on recordings, new zoom marker model (Module 04)
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
  if (oldVersion < 4) {
    await migrateToV4(transaction);
  }
}

/** Shape of a v2 project, which mixed recording facts with editable data. */
/** Interaction shape before v4. */
interface InteractionV3 {
  timeMs: number;
  type: 'click' | 'keypress' | 'scroll' | 'cursor';
  x: number;
  y: number;
}

/** Zoom marker shape before v4. */
interface ZoomMarkerV3 {
  id: string;
  startMs: number;
  endMs: number;
  scale: number;
  focus: { x: number; y: number };
  origin: 'auto' | 'manual';
}

type TimelineV3 = Omit<Project['timeline'], 'zoomMarkers'> & { zoomMarkers: ZoomMarkerV3[] };

/** Recording and project as written by the v3 step. */
type RecordingV3 = Omit<Recording, 'interactions' | 'clickTracking'>;
interface ProjectV3 extends Omit<Project, 'timeline' | 'zoom'> {
  timeline: TimelineV3;
  zoom: { mode: Project['zoom']['mode']; defaultScale: number; easing: Project['zoom']['easing'] };
  interactions?: InteractionV3[];
}

interface ProjectV2 {
  id: string;
  name: string;
  sessionId?: string;
  timeline: TimelineV3;
  interactions?: InteractionV3[];
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
    await recordings.add(({
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
    } satisfies RecordingV3) as Recording);
    await transaction.objectStore('projects').put(upgradeProject(old, recordingId) as unknown as Project);
  }
}

function upgradeProject(old: ProjectV2, recordingId: string): ProjectV3 {
  return {
    id: old.id,
    recordingId,
    schemaVersion: 1,
    timeline: old.timeline,
    zoom: { mode: 'auto', defaultScale: 2, easing: 'ease-in-out' },
    interactions: old.interactions ?? [],
    cameraLayout: old.cameraLayout,
    subtitles: [],
    importedAssetIds: [],
    exportSettings: defaultExportSettings(),
    createdAt: old.createdAt,
    updatedAt: old.updatedAt,
  };
}

const LEGACY_TRACKING = { mode: 'unsupported', reason: 'Recorded before click tracking was available.' } as const;

/**
 * v4: raw clicks become original data of the Recording (projects keep only editable markers), the
 * zoom marker model gains time/duration/transition, position mode, annotation, effect and enabled.
 */
async function migrateToV4(transaction: UpgradeTransaction): Promise<void> {
  const projects = transaction.objectStore('projects');
  const recordings = transaction.objectStore('recordings');

  for (const raw of (await projects.getAll()) as unknown as ProjectV3[]) {
    if (!raw.recordingId) continue; // pre-v3 project without media, deliberately left untouched
    const { interactions = [], ...rest } = raw;
    const project: Project = {
      ...rest,
      schemaVersion: 2,
      zoom: { ...defaultZoomSettings(), ...raw.zoom },
      timeline: { ...raw.timeline, zoomMarkers: raw.timeline.zoomMarkers.map((marker) => upgradeMarker(marker, raw.updatedAt)) },
    };
    await projects.put(project);

    const recording = (await recordings.get(raw.recordingId)) as RecordingV3 | Recording | undefined;
    if (recording && !('interactions' in recording)) {
      await recordings.put({ ...recording, interactions: upgradeInteractions(interactions), clickTracking: { ...LEGACY_TRACKING } });
    }
  }
  // Recordings whose project was missing still get the new fields.
  for (const recording of (await recordings.getAll()) as Array<RecordingV3 | Recording>) {
    if (!('interactions' in recording)) await recordings.put({ ...recording, interactions: [], clickTracking: { ...LEGACY_TRACKING } });
  }
}

export function upgradeMarker(old: ZoomMarkerV3, updatedAt: number): ZoomMarker {
  const span = Math.max(0, old.endMs - old.startMs);
  const transitionMs = Math.max(100, Math.min(600, Math.round(span / 3)));
  return {
    id: old.id,
    timeMs: old.startMs + transitionMs,
    position: { x: old.focus.x, y: old.focus.y },
    scale: old.scale,
    durationMs: Math.max(300, span - 2 * transitionMs),
    transitionMs,
    positionMode: 'fixed',
    effect: 'zoom',
    enabled: true,
    origin: old.origin,
    createdAt: updatedAt,
    updatedAt,
  };
}

function upgradeInteractions(old: InteractionV3[]): InteractionEvent[] {
  return old
    .filter((event) => event.type === 'click')
    .map((event) => ({
      id: createId('ev'),
      type: 'click',
      timeMs: event.timeMs,
      position: { x: event.x, y: event.y },
      button: 0,
      viewport: { width: 0, height: 0 },
    }));
}
