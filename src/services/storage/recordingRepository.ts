import type { MediaAsset, Project, Recording } from '@/types';
import { createId } from '@/utils/id';
import { getDb, withTransaction } from './db';

export const RECORDING_NAME_MAX_LENGTH = 120;

export class InvalidNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNameError';
  }
}

/** Trims and validates a user-entered recording name. */
export function normalizeRecordingName(name: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new InvalidNameError('Enter a name for the recording.');
  if (trimmed.length > RECORDING_NAME_MAX_LENGTH) {
    throw new InvalidNameError(`Use at most ${RECORDING_NAME_MAX_LENGTH} characters.`);
  }
  return trimmed;
}

/** Newest first. Reads metadata only; no media is loaded. */
export async function listRecordings(limit?: number): Promise<Recording[]> {
  const db = await getDb();
  const recordings: Recording[] = [];
  let cursor = await db.transaction('recordings').store.index('by-created').openCursor(null, 'prev');
  while (cursor && (limit === undefined || recordings.length < limit)) {
    recordings.push(cursor.value);
    cursor = await cursor.continue();
  }
  return recordings;
}

export async function countRecordings(): Promise<number> {
  return (await getDb()).count('recordings');
}

export async function getRecording(id: string): Promise<Recording | undefined> {
  return (await getDb()).get('recordings', id);
}

/** Resolves links that use a project id (older editor URLs). */
export async function findRecordingIdByProject(projectId: string): Promise<string | undefined> {
  return (await (await getDb()).get('projects', projectId))?.recordingId;
}

export interface RecordingDetails {
  recording: Recording;
  project: Project;
  /** Original and generated media of the recording, plus assets imported into the project. */
  assets: MediaAsset[];
}

/** Everything needed to open a recording, read in one consistent transaction. */
export async function getRecordingDetails(id: string): Promise<RecordingDetails | undefined> {
  const db = await getDb();
  const tx = db.transaction(['recordings', 'projects', 'assets']);
  const recording = await tx.objectStore('recordings').get(id);
  if (!recording) return undefined;
  const [project, own, imported] = await Promise.all([
    tx.objectStore('projects').get(recording.projectId),
    tx.objectStore('assets').index('by-recording').getAll(id),
    tx.objectStore('assets').index('by-project').getAll(recording.projectId),
  ]);
  if (!project) throw new Error('This recording’s project data is missing.');
  return { recording, project, assets: [...own, ...imported] };
}

/** Renames inside one read-write transaction, so concurrent edits from other pages are not lost. */
export async function renameRecording(id: string, name: string): Promise<Recording> {
  const normalized = normalizeRecordingName(name);
  return withTransaction(['recordings'], 'readwrite', async (tx) => {
    const recording = await tx.objectStore('recordings').get(id);
    if (!recording) throw new Error('This recording no longer exists.');
    const updated = { ...recording, name: normalized, updatedAt: Date.now() };
    await tx.objectStore('recordings').put(updated);
    return updated;
  });
}

/**
 * Permanently deletes a recording with its project, every asset and every blob, atomically: either
 * everything is removed or nothing is. Only ever called after the user confirms; ZoomCapture never
 * deletes recordings on its own (not even to free space).
 */
export async function deleteRecording(id: string): Promise<void> {
  await withTransaction(['recordings', 'projects', 'assets', 'assetBlobs'], 'readwrite', async (tx) => {
    const recording = await tx.objectStore('recordings').get(id);
    if (!recording) return;
    const assets = tx.objectStore('assets');
    const assetIds = [
      ...(await assets.index('by-recording').getAllKeys(id)),
      ...(await assets.index('by-project').getAllKeys(recording.projectId)),
    ];
    // Sequential awaits: if any request fails, no earlier request is left with an unhandled rejection.
    for (const assetId of assetIds) {
      await assets.delete(assetId);
      await tx.objectStore('assetBlobs').delete(assetId);
    }
    await tx.objectStore('projects').delete(recording.projectId);
    await tx.objectStore('recordings').delete(id);
  });
}

/** Stores a generated thumbnail and links it to the recording (replacing any previous one). */
export async function saveThumbnail(recordingId: string, blob: Blob, size: { width: number; height: number }): Promise<string> {
  return withTransaction(['recordings', 'assets', 'assetBlobs'], 'readwrite', async (tx) => {
    const recording = await tx.objectStore('recordings').get(recordingId);
    if (!recording) throw new Error('This recording no longer exists.');
    const asset: MediaAsset = {
      id: createId('ast'),
      kind: 'thumbnail',
      origin: 'generated',
      recordingId,
      mimeType: blob.type || 'image/jpeg',
      size: blob.size,
      startOffsetMs: 0,
      width: size.width,
      height: size.height,
      createdAt: Date.now(),
    };
    const previous = recording.thumbnailAssetId;
    await tx.objectStore('assets').add(asset);
    await tx.objectStore('assetBlobs').put(blob, asset.id);
    if (previous) {
      await tx.objectStore('assets').delete(previous);
      await tx.objectStore('assetBlobs').delete(previous);
    }
    await tx.objectStore('recordings').put({ ...recording, thumbnailAssetId: asset.id });
    return asset.id;
  });
}
