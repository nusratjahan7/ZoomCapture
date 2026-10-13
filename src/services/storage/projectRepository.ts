import type { MediaAsset, Project, Recording, ZoomMarker } from '@/types';
import { createId } from '@/utils/id';
import { getDb, withTransaction } from './db';

/** Editable project data. The original recording it builds on is never modified here. */
export async function getProject(id: string): Promise<Project | undefined> {
  return (await getDb()).get('projects', id);
}

export async function saveProject(project: Project): Promise<Project> {
  const saved = { ...project, updatedAt: Date.now() };
  await (await getDb()).put('projects', saved);
  return saved;
}

/**
 * Changes a project's zoom markers in one read-modify-write transaction, so edits made in another
 * page at the same time are not lost. `change` receives the stored markers and the (read-only)
 * recording, e.g. for its clicks and duration.
 */
export async function updateZoomMarkers(
  projectId: string,
  change: (markers: ZoomMarker[], context: { project: Project; recording: Recording }) => ZoomMarker[],
): Promise<Project> {
  return withTransaction(['projects', 'recordings'], 'readwrite', async (tx) => {
    const project = await tx.objectStore('projects').get(projectId);
    if (!project) throw new Error('This project no longer exists.');
    const recording = await tx.objectStore('recordings').get(project.recordingId);
    if (!recording) throw new Error('This recording no longer exists.');
    const updated: Project = {
      ...project,
      timeline: { ...project.timeline, zoomMarkers: change(project.timeline.zoomMarkers, { project, recording }) },
      updatedAt: Date.now(),
    };
    await tx.objectStore('projects').put(updated);
    return updated;
  });
}

/** Everything the editor changes in a project (the rest is owned by other operations). */
export type ProjectEdits = Pick<Project, 'timeline' | 'aspectRatio' | 'renderEffects' | 'zoom' | 'cameraLayout' | 'exportSettings'>;

/**
 * Autosave: writes the editor's state in one read-modify-write transaction. Fields the editor
 * doesn't own (imported asset ids, creation time) are kept from the stored project.
 */
export async function saveProjectEdits(projectId: string, edits: ProjectEdits): Promise<Project> {
  return withTransaction(['projects'], 'readwrite', async (tx) => {
    const stored = await tx.objectStore('projects').get(projectId);
    if (!stored) throw new Error('This project no longer exists, so the changes could not be saved.');
    const updated: Project = {
      ...stored,
      timeline: edits.timeline,
      aspectRatio: edits.aspectRatio,
      renderEffects: edits.renderEffects,
      zoom: edits.zoom,
      cameraLayout: edits.cameraLayout,
      exportSettings: edits.exportSettings,
      updatedAt: Date.now(),
    };
    await tx.objectStore('projects').put(updated);
    return updated;
  });
}

/** Media a user can import into a project. */
export const IMPORTABLE_TYPES = /^(video|audio|image)\//;

/**
 * Stores an imported file as a project asset (metadata, bytes and the project's list, in one
 * transaction). `info` comes from probing the file in the page (length, picture size).
 */
export async function importProjectAsset(
  projectId: string,
  file: Blob & { name?: string },
  info: { durationMs?: number; width?: number; height?: number; hasAudio?: boolean },
): Promise<MediaAsset> {
  const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('image/') ? 'image' : null;
  if (!kind) throw new Error('Only video, audio and image files can be imported.');
  const asset: MediaAsset = {
    id: createId('ast'),
    kind,
    origin: 'import',
    projectId,
    mimeType: file.type,
    size: file.size,
    durationMs: info.durationMs === undefined ? undefined : Math.round(info.durationMs),
    startOffsetMs: 0,
    width: info.width,
    height: info.height,
    label: (file.name ?? 'Imported file').slice(0, 120),
    hasAudio: info.hasAudio ?? kind !== 'image',
    createdAt: Date.now(),
  };
  return withTransaction(['projects', 'assets', 'assetBlobs'], 'readwrite', async (tx) => {
    const project = await tx.objectStore('projects').get(projectId);
    if (!project) throw new Error('This project no longer exists.');
    await tx.objectStore('assets').add(asset);
    await tx.objectStore('assetBlobs').put(file, asset.id);
    await tx.objectStore('projects').put({ ...project, importedAssetIds: [...project.importedAssetIds, asset.id], updatedAt: Date.now() });
    return asset;
  });
}

/**
 * Removes an imported file from a project and deletes its bytes. Refused while any clip uses it.
 * Only imported files can be removed this way; the recording's own media never is.
 */
export async function removeImportedAsset(projectId: string, assetId: string): Promise<void> {
  await withTransaction(['projects', 'assets', 'assetBlobs'], 'readwrite', async (tx) => {
    const project = await tx.objectStore('projects').get(projectId);
    const asset = await tx.objectStore('assets').get(assetId);
    if (!project || !asset) return;
    if (asset.origin !== 'import' || asset.projectId !== projectId) throw new Error('Only imported files can be removed from a project.');
    const used = project.timeline.tracks.some((track) => track.clips.some((clip) => clip.type === 'media' && clip.assetId === assetId));
    if (used) throw new Error('This file is used on the timeline. Delete its clips first.');
    await tx.objectStore('assets').delete(assetId);
    await tx.objectStore('assetBlobs').delete(assetId);
    await tx.objectStore('projects').put({ ...project, importedAssetIds: project.importedAssetIds.filter((id) => id !== assetId), updatedAt: Date.now() });
  });
}
