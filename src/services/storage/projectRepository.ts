import type { Project } from '@/types';
import { getDb } from './db';

/** Editable project data. The original recording it builds on is never modified here. */
export async function getProject(id: string): Promise<Project | undefined> {
  return (await getDb()).get('projects', id);
}

export async function saveProject(project: Project): Promise<Project> {
  const saved = { ...project, updatedAt: Date.now() };
  await (await getDb()).put('projects', saved);
  return saved;
}
