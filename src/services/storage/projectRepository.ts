import type { Project, ProjectSummary } from '@/types';
import { createId } from '@/utils/id';
import { getDb } from './db';

function toSummary(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    durationMs: project.timeline.durationMs,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

/** Builds a new, unsaved project with an empty timeline. */
export function createProject(name: string, sessionId?: string): Project {
  const now = Date.now();
  return {
    id: createId('prj'),
    name,
    sessionId,
    timeline: { durationMs: 0, tracks: [], zoomMarkers: [] },
    interactions: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Most recently updated projects first. */
export async function listProjects(limit?: number): Promise<ProjectSummary[]> {
  const db = await getDb();
  const summaries: ProjectSummary[] = [];
  let cursor = await db.transaction('projects').store.index('by-updated').openCursor(null, 'prev');
  while (cursor && (limit === undefined || summaries.length < limit)) {
    summaries.push(toSummary(cursor.value));
    cursor = await cursor.continue();
  }
  return summaries;
}

export async function countProjects(): Promise<number> {
  return (await getDb()).count('projects');
}

export async function getProject(id: string): Promise<Project | undefined> {
  return (await getDb()).get('projects', id);
}

export async function saveProject(project: Project): Promise<Project> {
  const saved = { ...project, updatedAt: Date.now() };
  await (await getDb()).put('projects', saved);
  return saved;
}

/** Deletes a project together with all of its assets and their blobs, atomically. */
export async function deleteProject(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['projects', 'assets', 'assetBlobs'], 'readwrite');
  const assetIds = await tx.objectStore('assets').index('by-project').getAllKeys(id);
  await Promise.all([
    tx.objectStore('projects').delete(id),
    ...assetIds.map((assetId) => tx.objectStore('assets').delete(assetId)),
    ...assetIds.map((assetId) => tx.objectStore('assetBlobs').delete(assetId)),
    tx.done,
  ]);
}
