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
const IMPORT_KINDS = ['video', 'audio', 'image', 'pdf'] as const;

/** What was found out about a file before importing it (see services/media/importFiles). */
export interface ImportDetails {
  kind: (typeof IMPORT_KINDS)[number];
  /** The real type, from the file's contents. */
  mimeType: string;
  info: { durationMs?: number; width?: number; height?: number; hasAudio?: boolean; pageCount?: number };
  fingerprint?: string;
  /** Recorded in the editor as narration. */
  voiceover?: boolean;
}

/**
 * Stores an imported file as a project asset (metadata, bytes and the project's list, in one
 * transaction). The bytes are stored once: a file with the same fingerprint already in the
 * project is reused (`reused: true`) instead of stored again. The original file is kept as it is.
 */
export async function importProjectAsset(
  projectId: string,
  file: Blob & { name?: string },
  details: ImportDetails,
): Promise<{ asset: MediaAsset; reused: boolean }> {
  if (!IMPORT_KINDS.includes(details.kind)) throw new Error('Only video, audio, image and PDF files can be imported.');
  const { info } = details;
  const asset: MediaAsset = {
    id: createId('ast'),
    kind: details.kind,
    origin: 'import',
    projectId,
    mimeType: details.mimeType,
    size: file.size,
    durationMs: info.durationMs === undefined ? undefined : Math.round(info.durationMs),
    startOffsetMs: 0,
    width: info.width,
    height: info.height,
    label: (file.name ?? 'Imported file').slice(0, 120),
    hasAudio: info.hasAudio ?? (details.kind === 'video' || details.kind === 'audio'),
    pageCount: details.kind === 'pdf' ? info.pageCount : undefined,
    fingerprint: details.fingerprint,
    voiceover: details.voiceover || undefined,
    createdAt: Date.now(),
  };
  return withTransaction(['projects', 'assets', 'assetBlobs'], 'readwrite', async (tx) => {
    const project = await tx.objectStore('projects').get(projectId);
    if (!project) throw new Error('This project no longer exists.');
    if (details.fingerprint) {
      for (const id of project.importedAssetIds) {
        const existing = await tx.objectStore('assets').get(id);
        if (existing?.fingerprint === details.fingerprint) return { asset: existing, reused: true };
      }
    }
    await tx.objectStore('assets').add(asset);
    await tx.objectStore('assetBlobs').put(file, asset.id);
    await tx.objectStore('projects').put({ ...project, importedAssetIds: [...project.importedAssetIds, asset.id], updatedAt: Date.now() });
    return { asset, reused: false };
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
