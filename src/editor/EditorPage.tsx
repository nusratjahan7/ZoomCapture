import { getQueryParam } from '@/services/navigation';
import { ProjectLibrary } from './components/ProjectLibrary';
import { ProjectWorkspace } from './components/ProjectWorkspace';

/** `editor/index.html` shows the project library; `?project=<id>` opens that project. */
export function EditorPage() {
  const projectId = getQueryParam('project');
  return projectId ? <ProjectWorkspace projectId={projectId} /> : <ProjectLibrary />;
}
