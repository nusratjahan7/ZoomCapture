import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Download, Film } from 'lucide-react';
import { downloadBlob } from '@/services/export/download';
import type { RenderProgress, RenderResult, RenderSettings } from '@/services/render/renderVideo';
import { frameSize } from '@/services/render/compose';
import { RESOLUTION_HEIGHT } from '@/services/render/output';
import { getAssetBlob } from '@/services/storage/assetRepository';
import { Button, Dialog, ProgressBar, SegmentedControl, Select, Toggle } from '@/shared/components';
import type { ExportSettings, MediaAsset, Project, Recording } from '@/types';
import { formatBytes, formatDuration } from '@/utils/format';
import { getErrorMessage } from '@/utils/errors';

type Phase =
  | { name: 'setup' }
  | { name: 'rendering'; progress: RenderProgress | null }
  | { name: 'done'; result: RenderResult; url: string }
  | { name: 'error'; message: string };

const RESOLUTIONS: Array<{ value: ExportSettings['resolution']; label: string }> = [
  { value: 'source', label: 'Same as recording' },
  { value: '2160p', label: '2160p (4K)' },
  { value: '1440p', label: '1440p' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
];

/**
 * Renders the recording with its zoom effects into a new WebM video (in this tab, with WebCodecs)
 * and offers it for download. The original recording is not changed.
 */
export function RenderVideoDialog({
  open,
  onClose,
  recording,
  project,
  assets,
  onSettingsChange,
}: {
  open: boolean;
  onClose: () => void;
  recording: Recording;
  project: Project;
  assets: readonly MediaAsset[];
  onSettingsChange: (settings: ExportSettings) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ name: 'setup' });
  const settings = project.exportSettings;
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  const hasCamera = Boolean(project.cameraLayout && assets.some((asset) => asset.kind === 'camera' && asset.origin === 'recording'));
  const source = { width: recording.width ?? 1920, height: recording.height ?? 1080 };
  // Only sizes up to the recording's own (rendering never upscales).
  // Only sizes up to the recording's own; the resolution names the short side of the output.
  const resolutions = RESOLUTIONS.filter((option) => option.value === 'source' || RESOLUTION_HEIGHT[option.value] < Math.min(source.width, source.height));
  const size = frameSize(source, project.aspectRatio, settings.resolution, project.customSize);

  const releaseUrl = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  };

  // Leaving the page while rendering would lose the work: ask first.
  useEffect(() => {
    if (phase.name !== 'rendering') return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [phase.name]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      releaseUrl();
    },
    [],
  );

  const close = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    releaseUrl();
    setPhase({ name: 'setup' });
    onClose();
  };

  const start = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    releaseUrl();
    setPhase({ name: 'rendering', progress: null });
    try {
      // The bytes of every asset used on the timeline (read lazily from IndexedDB-backed blobs).
      const used = new Set(project.timeline.tracks.flatMap((track) => track.clips.flatMap((clip) => (clip.type === 'media' ? [clip.assetId] : []))));
      // The background image too (it isn't on the timeline).
      if (project.background?.kind === 'image' && project.background.imageAssetId) used.add(project.background.imageAssetId);
      const [entries, { renderProject }] = await Promise.all([
        Promise.all([...used].map(async (id) => [id, await getAssetBlob(id)] as const)),
        // Loaded on demand: the encoder library is only needed when rendering.
        import('@/services/render/renderVideo'),
      ]);
      const blobs = new Map(entries.flatMap(([id, blob]) => (blob ? [[id, blob] as const] : [])));
      if (used.has(recording.screenAssetId) && !blobs.has(recording.screenAssetId)) throw new Error('The recording file is missing from local storage.');
      const renderSettings: RenderSettings = {
        resolution: settings.resolution,
        frameRate: settings.frameRate,
        quality: settings.quality,
        includeCamera: settings.includeCamera && hasCamera,
      };
      const result = await renderProject({ recording, project, assets, blobs }, renderSettings, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (!controller.signal.aborted) setPhase({ name: 'rendering', progress });
        },
      });
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(result.blob);
      urlRef.current = url;
      setPhase({ name: 'done', result, url });
    } catch (error) {
      if (controller.signal.aborted) return;
      setPhase({ name: 'error', message: getErrorMessage(error) });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const update = (patch: Partial<ExportSettings>) => onSettingsChange({ ...settings, ...patch });

  return (
    <Dialog
      open={open}
      onClose={close}
      size={phase.name === 'done' ? 'lg' : 'md'}
      title="Export video"
      description="Renders the edited timeline (cuts, layers, text, zoom effects and audio) into a new WebM video, exactly as in the preview. The original recording is not changed."
      footer={
        phase.name === 'setup' || phase.name === 'error' ? (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" icon={Film} onClick={() => void start()}>
              {phase.name === 'error' ? 'Try again' : 'Render'}
            </Button>
          </>
        ) : phase.name === 'rendering' ? (
          <Button variant="ghost" onClick={close}>
            Cancel rendering
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
            <Button variant="primary" icon={Download} onClick={() => downloadBlob(phase.result.blob, phase.result.fileName)}>
              Download
            </Button>
          </>
        )
      }
    >
      {(phase.name === 'setup' || phase.name === 'error') && (
        <div className="space-y-4">
          <Select
            label="Resolution"
            description={`${size.width}×${size.height}`}
            options={resolutions}
            value={settings.resolution}
            onValueChange={(value) => update({ resolution: value as ExportSettings['resolution'] })}
          />
          <div>
            <p className="mb-1.5 text-sm font-medium">Frame rate</p>
            <SegmentedControl
              label="Frame rate"
              options={[
                { value: 30, label: '30 fps' },
                { value: 60, label: '60 fps' },
              ]}
              value={settings.frameRate}
              onChange={(frameRate) => update({ frameRate })}
            />
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">Quality</p>
            <SegmentedControl
              label="Quality"
              options={[
                { value: 'standard', label: 'Standard (smaller file)' },
                { value: 'high', label: 'High' },
              ]}
              value={settings.quality}
              onChange={(quality) => update({ quality })}
            />
          </div>
          {hasCamera && (
            <Toggle label="Include camera bubble" checked={settings.includeCamera} onCheckedChange={(includeCamera) => update({ includeCamera })} />
          )}
          {phase.name === 'error' && (
            <p role="alert" className="flex gap-2 rounded-lg bg-rec/10 p-2.5 text-sm text-rec">
              <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0" />
              <span>Rendering failed: {phase.message}</span>
            </p>
          )}
        </div>
      )}

      {phase.name === 'rendering' && (
        <div className="space-y-2" aria-live="polite">
          <ProgressBar value={phase.progress?.fraction ?? 0} label="Rendering progress" />
          <p className="text-sm text-fg-muted">
            {phase.progress
              ? `Rendering frame ${phase.progress.frame} of ${phase.progress.frames} (${Math.round(phase.progress.fraction * 100)} %)`
              : 'Preparing…'}
          </p>
          <p className="text-xs text-fg-subtle">Keep this tab open until rendering finishes.</p>
        </div>
      )}

      {phase.name === 'done' && (
        <div className="space-y-3">
          <video
            src={phase.url}
            controls
            playsInline
            data-testid="rendered-video"
            aria-label="Rendered video"
            className="aspect-video w-full rounded-xl bg-black"
          />
          <p className="text-sm text-fg-muted" data-testid="render-summary">
            {phase.result.width}×{phase.result.height} · {phase.result.frameRate} fps · {formatDuration(phase.result.durationSeconds * 1000)} ·{' '}
            {phase.result.videoCodec.toUpperCase()} ·{' '}
            {phase.result.audio === 'none' ? 'no audio' : 'audio mixed'} ·{' '}
            {formatBytes(phase.result.blob.size)}
          </p>
          {phase.result.warnings.map((warning) => (
            <p key={warning} className="flex gap-2 rounded-lg bg-warning/10 p-2.5 text-xs text-warning">
              <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
              {warning}
            </p>
          ))}
        </div>
      )}
    </Dialog>
  );
}
