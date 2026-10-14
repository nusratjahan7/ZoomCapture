import { buildProject } from '@/services/recording/finalizeRecording';
import type { MediaAsset, Project, Recording } from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import { createId } from '@/utils/id';
import { getDb, withTransaction } from './db';
import { RECORDING_NAME_MAX_LENGTH } from './recordingRepository';

/**
 * The project library: every recording with its editable project, for the dashboard. Reads
 * metadata only (no media), in one transaction. Also duplicates projects and rebuilds a project
 * whose record is missing.
 */

export interface LibraryEntry {
  recording: Recording;
  /** Null when the project record is missing: it can be rebuilt from the recording (`rebuildProject`). */
  project: Pick<Project, 'id' | 'createdAt' | 'updatedAt' | 'aspectRatio'> & { clipCount: number; importedCount: number; edited: boolean } | null;
  /** The recording's media plus files imported into the project (bytes). */
  totalBytes: number;
  /** Last change to the recording or its project. */
  modifiedAt: number;
}

export async function listLibrary(): Promise<LibraryEntry[]> {
  const db = await getDb();
  const tx = db.transaction(['recordings', 'projects', 'assets']);
  const [recordings, projects, assets] = await Promise.all([
    tx.objectStore('recordings').getAll(),
    tx.objectStore('projects').getAll(),
    tx.objectStore('assets').getAll(),
  ]);
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const importedBytes = new Map<string, { bytes: number; count: number }>();
  for (const asset of assets) {
    if (!asset.projectId || asset.recordingId) continue;
    const current = importedBytes.get(asset.projectId) ?? { bytes: 0, count: 0 };
    importedBytes.set(asset.projectId, { bytes: current.bytes + asset.size, count: current.count + 1 });
  }
  return recordings
    .map((recording) => {
      const project = projectById.get(recording.projectId);
      const imported = importedBytes.get(recording.projectId) ?? { bytes: 0, count: 0 };
      return {
        recording,
        project: project
          ? {
              id: project.id,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              aspectRatio: project.aspectRatio,
              // Tolerant of damaged records: one bad project must not hide the whole library.
              clipCount: (project.timeline?.tracks ?? []).reduce((sum, track) => sum + (track.clips?.length ?? 0), 0),
              importedCount: imported.count,
              edited: project.updatedAt > project.createdAt,
            }
          : null,
        totalBytes: recording.sizeBytes + imported.bytes,
        modifiedAt: Math.max(recording.updatedAt, project?.updatedAt ?? 0),
      };
    })
    .sort((a, b) => b.recording.createdAt - a.recording.createdAt);
}

export type LibrarySort = 'modified' | 'created' | 'name' | 'duration' | 'size';

/** Search (name, case- and accent-insensitive) and sort, for the dashboard. Pure. */
export function filterLibrary(entries: readonly LibraryEntry[], query: string, sort: LibrarySort, descending: boolean): LibraryEntry[] {
  const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const words = fold(query).split(/\s+/).filter(Boolean);
  const matching = entries.filter((entry) => {
    const name = fold(entry.recording.name);
    return words.every((word) => name.includes(word));
  });
  const key = (entry: LibraryEntry): number | string => {
    switch (sort) {
      case 'modified':
        return entry.modifiedAt;
      case 'created':
        return entry.recording.createdAt;
      case 'name':
        return fold(entry.recording.name);
      case 'duration':
        return entry.recording.durationMs;
      case 'size':
        return entry.totalBytes;
    }
  };
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...matching].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const order = typeof ka === 'string' ? collator.compare(ka, kb as string) : ka - (kb as number);
    // Ties: newest first, so the order is stable.
    return (descending ? -order : order) || b.recording.createdAt - a.recording.createdAt;
  });
}

/** "Demo (copy)", "Demo (copy 2)"… not used by another recording, within the name limit. */
export function copyName(name: string, taken: ReadonlySet<string>): string {
  const base = name.replace(/ \(copy(?: \d+)?\)$/, '');
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' (copy)' : ` (copy ${n})`;
    const candidate = `${base.slice(0, RECORDING_NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Duplicates a recording and its project (with every edit and imported file) as a new, independent
 * project, in one transaction: media is copied, so deleting either copy never affects the other.
 * The caller checks there is enough free space first (it needs the original's size again).
 */
export async function duplicateProject(recordingId: string): Promise<Recording> {
  const db = await getDb();
  const taken = new Set((await db.getAll('recordings')).map((recording) => recording.name));
  return withTransaction(['recordings', 'projects', 'assets', 'assetBlobs'], 'readwrite', async (tx) => {
    const recording = await tx.objectStore('recordings').get(recordingId);
    if (!recording) throw new Error('This recording no longer exists.');
    const project = await tx.objectStore('projects').get(recording.projectId);
    if (!project) throw new Error('This recording’s project is missing: rebuild it first.');
    const assets = tx.objectStore('assets');
    const owned = [...(await assets.index('by-recording').getAll(recordingId)), ...(await assets.index('by-project').getAll(recording.projectId))];
    const now = Date.now();
    const newRecordingId = createId('rec');
    const newProjectId = createId('prj');
    const ids = new Map(owned.map((asset) => [asset.id, createId('ast')]));
    const mapId = (id: string) => ids.get(id) ?? id;
    for (const asset of owned) {
      const blob = await tx.objectStore('assetBlobs').get(asset.id);
      const copy: MediaAsset = {
        ...asset,
        id: mapId(asset.id),
        recordingId: asset.recordingId ? newRecordingId : undefined,
        projectId: asset.projectId ? newProjectId : undefined,
        createdAt: now,
      };
      await assets.add(copy);
      if (blob) await tx.objectStore('assetBlobs').put(blob, copy.id);
    }
    const copy: Recording = {
      ...recording,
      id: newRecordingId,
      name: copyName(recording.name, taken),
      projectId: newProjectId,
      // Not the original's capture session: a resumed save must never find the copy.
      sessionId: undefined,
      screenAssetId: mapId(recording.screenAssetId),
      assetIds: recording.assetIds.map(mapId),
      thumbnailAssetId: recording.thumbnailAssetId ? mapId(recording.thumbnailAssetId) : undefined,
      createdAt: now,
      updatedAt: now,
    };
    const projectCopy: Project = {
      ...structuredClone(project),
      id: newProjectId,
      recordingId: newRecordingId,
      importedAssetIds: project.importedAssetIds.map(mapId),
      createdAt: now,
      updatedAt: now,
    };
    for (const track of projectCopy.timeline.tracks) for (const clip of track.clips) if (clip.type === 'media') clip.assetId = mapId(clip.assetId);
    if (projectCopy.background?.imageAssetId) projectCopy.background.imageAssetId = mapId(projectCopy.background.imageAssetId);
    await tx.objectStore('recordings').add(copy);
    await tx.objectStore('projects').add(projectCopy);
    return copy;
  });
}

/**
 * Rebuilds the editable project of a recording whose project record is missing (e.g. data left by
 * an interrupted operation or an older version): the timeline is made again from the recording's
 * own media and clicks, as when it was saved. The recording and its media are not changed.
 */
export async function rebuildProject(recordingId: string): Promise<Project> {
  return withTransaction(['recordings', 'projects', 'assets'], 'readwrite', async (tx) => {
    const recording = await tx.objectStore('recordings').get(recordingId);
    if (!recording) throw new Error('This recording no longer exists.');
    const existing = await tx.objectStore('projects').get(recording.projectId);
    if (existing) return existing;
    const assets = (await tx.objectStore('assets').index('by-recording').getAll(recordingId)).filter((asset) => asset.origin === 'recording');
    if (!assets.some((asset) => asset.id === recording.screenAssetId)) throw new Error('The recording’s video is missing, so its project can’t be rebuilt.');
    const project = buildProject(recording, assets, {
      projectId: recording.projectId,
      now: Date.now(),
      autoZoom: DEFAULT_SETTINGS.autoZoom,
      cameraLayout: DEFAULT_SETTINGS.cameraBubble,
    });
    await tx.objectStore('projects').add(project);
    return project;
  });
}

export interface OrphanReport {
  /** Media records whose recording and project are both gone (bytes and count). */
  bytes: number;
  count: number;
  ids: string[];
}

/**
 * Media left behind without a recording or project (normally impossible, since deletes are
 * atomic; possible after manual database edits or a browser crash in an old version). Reported in
 * Settings; removed only when the user asks.
 */
export async function findOrphanedMedia(): Promise<OrphanReport> {
  const db = await getDb();
  const tx = db.transaction(['recordings', 'projects', 'assets', 'recordingDrafts']);
  const [recordings, projects, assets, drafts] = await Promise.all([
    tx.objectStore('recordings').getAllKeys(),
    tx.objectStore('projects').getAllKeys(),
    tx.objectStore('assets').getAll(),
    tx.objectStore('recordingDrafts').getAll(),
  ]);
  const recordingIds = new Set<string>(recordings);
  const projectIds = new Set<string>(projects);
  // Media of a recording still being saved belongs to its draft (not yet a recording).
  const draftRecordingIds = new Set(drafts.flatMap((draft) => (draft.recordingId ? [draft.recordingId] : [])));
  const orphans = assets.filter(
    (asset) =>
      !(asset.recordingId && (recordingIds.has(asset.recordingId) || draftRecordingIds.has(asset.recordingId))) &&
      !(asset.projectId && projectIds.has(asset.projectId)),
  );
  return { bytes: orphans.reduce((sum, asset) => sum + asset.size, 0), count: orphans.length, ids: orphans.map((asset) => asset.id) };
}

/** Removes the media `findOrphanedMedia` reported (only those ids, re-checked in the same transaction). */
export async function removeOrphanedMedia(ids: readonly string[]): Promise<number> {
  return withTransaction(['recordings', 'projects', 'assets', 'assetBlobs'], 'readwrite', async (tx) => {
    let removed = 0;
    for (const id of ids) {
      const asset = await tx.objectStore('assets').get(id);
      if (!asset) continue;
      const owned =
        (asset.recordingId && (await tx.objectStore('recordings').get(asset.recordingId))) || (asset.projectId && (await tx.objectStore('projects').get(asset.projectId)));
      if (owned) continue;
      await tx.objectStore('assets').delete(id);
      await tx.objectStore('assetBlobs').delete(id);
      removed++;
    }
    return removed;
  });
}
