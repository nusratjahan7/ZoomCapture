import type { Project, Recording, ZoomMarker } from '@/types';
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

/** Project fields edited as settings (overlays, export choices). */
export type ProjectSettingsPatch = Partial<Pick<Project, 'renderEffects' | 'exportSettings'>>;

/** Applies a settings change in one read-modify-write transaction (see `updateZoomMarkers`). */
export async function updateProjectSettings(projectId: string, change: (project: Project) => ProjectSettingsPatch): Promise<Project> {
  return withTransaction(['projects'], 'readwrite', async (tx) => {
    const project = await tx.objectStore('projects').get(projectId);
    if (!project) throw new Error('This project no longer exists.');
    const updated: Project = { ...project, ...change(project), updatedAt: Date.now() };
    await tx.objectStore('projects').put(updated);
    return updated;
  });
}
