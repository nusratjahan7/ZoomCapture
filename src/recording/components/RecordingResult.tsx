import { useEffect, useState } from 'react';
import { AudioLines, CheckCircle2, Download, Monitor, PencilRuler, RotateCcw, TriangleAlert, Video, type LucideIcon } from 'lucide-react';
import { downloadBlob } from '@/services/export/download';
import { exportProject } from '@/services/export/exporters';
import { sendMessage } from '@/services/messaging';
import { describeMimeType } from '@/services/recording/mimeTypes';
import { getAssetBlob, listAssets } from '@/services/storage/assetRepository';
import { getProject } from '@/services/storage/projectRepository';
import { Button, Panel, useToast } from '@/shared/components';
import type { MediaAsset, MediaAssetKind, Project } from '@/types';
import { getErrorMessage } from '@/utils/errors';
import { formatBytes, formatDuration } from '@/utils/format';

const KIND_INFO: Record<MediaAssetKind, { label: string; icon: LucideIcon }> = {
  screen: { label: 'Screen', icon: Monitor },
  camera: { label: 'Camera', icon: Video },
  microphone: { label: 'Microphone', icon: AudioLines },
  'system-audio': { label: 'Tab / system audio', icon: AudioLines },
  image: { label: 'Image', icon: Monitor },
};

/** Shown after a recording is saved: preview, download, and next steps. */
export function RecordingResult({ projectId, onRecordAgain }: { projectId: string; onRecordAgain: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<{ project: Project; assets: MediaAsset[] } | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let active = true;
    void (async () => {
      const [project, assets] = await Promise.all([getProject(projectId), listAssets(projectId)]);
      if (!active || !project) return;
      setData({ project, assets });
      const screen = assets.find((asset) => asset.kind === 'screen');
      const blob = screen && (await getAssetBlob(screen.id));
      if (!active || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setVideoUrl(objectUrl);
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId]);

  const download = async () => {
    if (!data) return;
    setDownloading(true);
    try {
      const { blob, fileName } = await exportProject(data.project, data.assets, 'webm');
      downloadBlob(blob, fileName);
    } catch (error) {
      toast.show({ variant: 'error', title: 'Download failed', description: getErrorMessage(error) });
    } finally {
      setDownloading(false);
    }
  };

  const screen = data?.assets.find((asset) => asset.kind === 'screen');
  const interrupted = data?.assets.filter((asset) => asset.endedEarly) ?? [];

  return (
    <main className="mx-auto grid w-full max-w-7xl flex-1 gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={20} aria-hidden className="text-success" />
          <h1 className="text-xl font-semibold tracking-tight">Recording saved</h1>
        </div>
        <Panel className="p-3">
          <div className="aspect-video overflow-hidden rounded-xl border border-line bg-black">
            {videoUrl && (
              <video src={videoUrl} controls className="h-full w-full" aria-label="Preview of your recording" />
            )}
          </div>
        </Panel>
      </div>

      <aside className="space-y-4">
        <Panel title={data?.project.name ?? 'Recording'}>
          <dl className="space-y-2.5 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-fg-subtle">Duration</dt>
              <dd>{formatDuration(data?.project.timeline.durationMs ?? 0)}</dd>
            </div>
            {screen && (
              <>
                <div className="flex justify-between gap-4">
                  <dt className="text-fg-subtle">Format</dt>
                  <dd>{describeMimeType(screen.mimeType)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-fg-subtle">Resolution</dt>
                  <dd>{screen.width && screen.height ? `${screen.width}×${screen.height}` : '—'}</dd>
                </div>
              </>
            )}
            <div className="flex justify-between gap-4">
              <dt className="text-fg-subtle">Size</dt>
              <dd>{formatBytes(data?.assets.reduce((sum, asset) => sum + asset.size, 0) ?? 0)}</dd>
            </div>
          </dl>
          <h3 className="mt-4 mb-2 text-xs font-semibold tracking-wider text-fg-subtle uppercase">Recorded tracks</h3>
          <ul className="space-y-1.5">
            {data?.assets.map((asset) => {
              const { label, icon: Icon } = KIND_INFO[asset.kind];
              return (
                <li key={asset.id} className="flex items-center gap-2 text-sm">
                  <Icon size={14} aria-hidden className="text-fg-subtle" />
                  <span className="flex-1 truncate" title={asset.label}>
                    {label}
                  </span>
                  <span className="text-xs text-fg-subtle">{formatBytes(asset.size)}</span>
                </li>
              );
            })}
          </ul>
          {interrupted.length > 0 && (
            <p className="mt-3 flex gap-2 rounded-lg bg-warning/10 p-2 text-xs text-warning">
              <TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />
              {interrupted.map((asset) => KIND_INFO[asset.kind].label).join(', ')} stopped before the recording ended.
            </p>
          )}
        </Panel>

        <div className="space-y-2">
          <Button variant="primary" fullWidth icon={Download} loading={downloading} disabled={!data} onClick={() => void download()}>
            Download {screen ? `(${formatBytes(screen.size)})` : ''}
          </Button>
          <Button
            fullWidth
            icon={PencilRuler}
            onClick={() => void sendMessage('page/open', { page: 'editor', params: { project: projectId } })}
          >
            Open in editor
          </Button>
          <Button fullWidth variant="ghost" icon={RotateCcw} onClick={onRecordAgain}>
            Record again
          </Button>
        </div>
      </aside>
    </main>
  );
}
