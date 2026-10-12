import { useEffect, useRef, useState, type RefObject } from 'react';
import { ArrowLeft, AudioLines, Download, FileQuestion, Film, Loader2, Monitor, Video, type LucideIcon } from 'lucide-react';
import { downloadBlob } from '@/services/export/download';
import { assetFileName, exportProject } from '@/services/export/exporters';
import { describeMimeType } from '@/services/recording/mimeTypes';
import { getAssetBlob, listAssets } from '@/services/storage/assetRepository';
import { getProject } from '@/services/storage/projectRepository';
import { Button, buttonClassName, EmptyState, IconButton, Panel, useToast } from '@/shared/components';
import { CAMERA_BUBBLE_SCALE, type MediaAsset, type MediaAssetKind, type Project } from '@/types';
import { getErrorMessage } from '@/utils/errors';
import { formatBytes, formatDuration } from '@/utils/format';
import { EditorHeader } from './EditorHeader';
import { TimelineView } from './TimelineView';

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; project: Project; assets: MediaAsset[] };

const ASSET_INFO: Record<MediaAssetKind, { label: string; icon: LucideIcon }> = {
  screen: { label: 'Screen + mixed audio', icon: Monitor },
  camera: { label: 'Camera', icon: Video },
  microphone: { label: 'Microphone', icon: AudioLines },
  'system-audio': { label: 'Tab / system audio', icon: AudioLines },
  image: { label: 'Image', icon: Film },
};

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

/**
 * Keeps a muted follower video (the camera track) in step with the main player, honouring the
 * follower's start offset. Drift above 150 ms is corrected by seeking.
 */
function useFollowerSync(
  mainRef: RefObject<HTMLVideoElement | null>,
  followerRef: RefObject<HTMLVideoElement | null>,
  offsetMs: number,
  enabled: boolean,
) {
  useEffect(() => {
    const main = mainRef.current;
    const follower = followerRef.current;
    if (!enabled || !main || !follower) return;
    const sync = () => {
      const target = Math.max(0, main.currentTime - offsetMs / 1000);
      if (Math.abs(follower.currentTime - target) > 0.15) follower.currentTime = target;
    };
    const onPlay = () => {
      sync();
      void follower.play().catch(() => undefined);
    };
    const onPause = () => {
      follower.pause();
      sync();
    };
    const onRate = () => (follower.playbackRate = main.playbackRate);
    const events: Array<[string, () => void]> = [
      ['play', onPlay],
      ['pause', onPause],
      ['seeked', sync],
      ['timeupdate', sync],
      ['ratechange', onRate],
    ];
    events.forEach(([name, handler]) => main.addEventListener(name, handler));
    return () => events.forEach(([name, handler]) => main.removeEventListener(name, handler));
  }, [mainRef, followerRef, offsetMs, enabled]);
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
  const toast = useToast();
  const screenAsset = assets.find((asset) => asset.kind === 'screen');
  const cameraAsset = assets.find((asset) => asset.kind === 'camera');
  const videoUrl = useAssetUrl(screenAsset?.id);
  const cameraUrl = useAssetUrl(project.cameraLayout ? cameraAsset?.id : undefined);
  const totalSize = assets.reduce((sum, asset) => sum + asset.size, 0);
  const mainRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<HTMLVideoElement>(null);
  const [exporting, setExporting] = useState(false);
  useFollowerSync(mainRef, cameraRef, cameraAsset?.startOffsetMs ?? 0, Boolean(videoUrl && cameraUrl));

  useEffect(() => {
    document.title = `${project.name} · ZoomCapture`;
  }, [project.name]);

  const downloadRecording = async () => {
    setExporting(true);
    try {
      const { blob, fileName } = await exportProject(project, assets, 'webm');
      downloadBlob(blob, fileName);
    } catch (error) {
      toast.show({ variant: 'error', title: 'Download failed', description: getErrorMessage(error) });
    } finally {
      setExporting(false);
    }
  };

  const downloadAsset = async (asset: MediaAsset) => {
    const blob = await getAssetBlob(asset.id);
    if (blob) downloadBlob(blob, assetFileName(project, asset));
    else toast.show({ variant: 'error', title: 'This file is missing from local storage' });
  };

  const details: Array<[string, string]> = [
    ['Duration', formatDuration(project.timeline.durationMs)],
    ['Source', project.source?.label ?? '—'],
    ['Storage used', formatBytes(totalSize)],
    ['Zoom markers', String(project.timeline.zoomMarkers.length)],
    ['Created', new Date(project.createdAt).toLocaleString()],
  ];

  const layout = project.cameraLayout;
  const bubbleWidth = layout ? CAMERA_BUBBLE_SCALE[layout.size] * 100 : 0;

  return (
    <div className="flex min-h-screen flex-col">
      <EditorHeader>
        {backLink}
        {screenAsset && (
          <Button variant="primary" size="sm" icon={Download} loading={exporting} onClick={() => void downloadRecording()}>
            Download
          </Button>
        )}
      </EditorHeader>
      <main className="mx-auto grid w-full max-w-7xl flex-1 gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <h1 className="truncate text-xl font-semibold tracking-tight">{project.name}</h1>
          <Panel className="p-3">
            <div className="relative aspect-video overflow-hidden rounded-xl border border-line bg-black">
              {videoUrl ? (
                <>
                  <video
                    ref={mainRef}
                    src={videoUrl}
                    controls
                    className="h-full w-full"
                    aria-label={`${project.name} recording`}
                  />
                  {cameraUrl && layout && (
                    // Preview of the camera placement; final compositing happens at export.
                    <video
                      ref={cameraRef}
                      src={cameraUrl}
                      muted
                      playsInline
                      aria-hidden
                      className="pointer-events-none absolute aspect-square -translate-x-1/2 -translate-y-1/2 -scale-x-100 rounded-full border-2 border-white/80 object-cover"
                      style={{ left: `${layout.x * 100}%`, top: `${layout.y * 100}%`, width: `${bubbleWidth}%` }}
                    />
                  )}
                </>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <EmptyState icon={Film} title="No screen recording in this project" compact />
                </div>
              )}
            </div>
          </Panel>
          <TimelineView timeline={project.timeline} />
        </div>

        <div className="space-y-4">
          <Panel as="aside" title="Project details">
            <dl className="space-y-3 text-sm">
              {details.map(([term, value]) => (
                <div key={term} className="flex justify-between gap-4">
                  <dt className="shrink-0 text-fg-subtle">{term}</dt>
                  <dd className="truncate text-right text-fg" title={value}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel title="Media files" description="Each source is stored separately for editing.">
            {assets.length === 0 ? (
              <p className="text-sm text-fg-subtle">No media.</p>
            ) : (
              <ul className="space-y-2">
                {assets.map((asset) => {
                  const { label, icon: Icon } = ASSET_INFO[asset.kind];
                  return (
                    <li key={asset.id} className="flex items-center gap-3 rounded-xl bg-surface-2 p-2.5">
                      <Icon size={16} aria-hidden className="shrink-0 text-fg-subtle" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium" title={asset.label}>
                          {label}
                        </p>
                        <p className="truncate text-xs text-fg-subtle">
                          {describeMimeType(asset.mimeType)} · {formatDuration(asset.durationMs ?? 0)} ·{' '}
                          {formatBytes(asset.size)}
                          {asset.endedEarly && ' · ended early'}
                        </p>
                      </div>
                      <IconButton
                        icon={Download}
                        label={`Download ${label.toLowerCase()}`}
                        size="sm"
                        tooltipAlign="end"
                        onClick={() => void downloadAsset(asset)}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>
      </main>
    </div>
  );
}
