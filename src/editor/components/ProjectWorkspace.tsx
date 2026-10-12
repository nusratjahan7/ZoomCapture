import { useEffect, useState } from 'react';
import { ArrowLeft, FileQuestion, Film, Loader2 } from 'lucide-react';
import { getAssetBlob, listAssets } from '@/services/storage/assetRepository';
import { getProject } from '@/services/storage/projectRepository';
import { buttonClassName, EmptyState, Panel } from '@/shared/components';
import type { MediaAsset, Project } from '@/types';
import { getErrorMessage } from '@/utils/errors';
import { formatBytes, formatDuration } from '@/utils/format';
import { EditorHeader } from './EditorHeader';
import { TimelineView } from './TimelineView';

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; project: Project; assets: MediaAsset[] };

function useProject(projectId: string): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    Promise.all([getProject(projectId), listAssets(projectId)]).then(
      ([project, assets]) => active && setState(project ? { status: 'ready', project, assets } : { status: 'missing' }),
      (error: unknown) => active && setState({ status: 'error', message: getErrorMessage(error) }),
    );
    return () => {
      active = false;
    };
  }, [projectId]);
  return state;
}

/** Object URL for a stored asset blob, revoked when the asset changes or the view unmounts. */
function useAssetUrl(assetId: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!assetId) return;
    let objectUrl: string | null = null;
    let active = true;
    void getAssetBlob(assetId).then((blob) => {
      if (!active || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [assetId]);
  return url;
}

const backLink = (
  <a href="index.html" className={buttonClassName({ variant: 'ghost', size: 'sm' })}>
    <ArrowLeft size={14} aria-hidden />
    All projects
  </a>
);

export function ProjectWorkspace({ projectId }: { projectId: string }) {
  const state = useProject(projectId);

  if (state.status !== 'ready') {
    return (
      <div className="min-h-screen">
        <EditorHeader />
        <main className="flex min-h-[70vh] items-center justify-center p-6">
          {state.status === 'loading' ? (
            <Loader2 size={28} aria-label="Loading project" className="animate-spin text-fg-subtle" />
          ) : (
            <EmptyState
              icon={FileQuestion}
              title={state.status === 'missing' ? 'Project not found' : 'Could not open this project'}
              description={
                state.status === 'missing' ? 'It may have been deleted from this browser.' : state.message
              }
              action={backLink}
            />
          )}
        </main>
      </div>
    );
  }

  return <Workspace project={state.project} assets={state.assets} />;
}

function Workspace({ project, assets }: { project: Project; assets: MediaAsset[] }) {
  const screenAsset = assets.find((asset) => asset.kind === 'screen');
  const videoUrl = useAssetUrl(screenAsset?.id);
  const totalSize = assets.reduce((sum, asset) => sum + asset.size, 0);

  useEffect(() => {
    document.title = `${project.name} · ZoomCapture`;
  }, [project.name]);

  const details: Array<[string, string]> = [
    ['Duration', formatDuration(project.timeline.durationMs)],
    ['Media assets', `${assets.length} · ${formatBytes(totalSize)}`],
    ['Zoom markers', String(project.timeline.zoomMarkers.length)],
    ['Created', new Date(project.createdAt).toLocaleString()],
    ['Last edited', new Date(project.updatedAt).toLocaleString()],
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <EditorHeader>{backLink}</EditorHeader>
      <main className="mx-auto grid w-full max-w-7xl flex-1 gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4">
          <h1 className="truncate text-xl font-semibold tracking-tight">{project.name}</h1>
          <Panel className="p-3">
            <div className="aspect-video overflow-hidden rounded-xl border border-line bg-black">
              {videoUrl ? (
                <video src={videoUrl} controls className="h-full w-full" aria-label={`${project.name} recording`} />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <EmptyState icon={Film} title="No screen recording in this project" compact />
                </div>
              )}
            </div>
          </Panel>
          <TimelineView timeline={project.timeline} />
        </div>

        <Panel as="aside" title="Project details">
          <dl className="space-y-3 text-sm">
            {details.map(([term, value]) => (
              <div key={term} className="flex justify-between gap-4">
                <dt className="text-fg-subtle">{term}</dt>
                <dd className="text-right text-fg">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </main>
    </div>
  );
}
