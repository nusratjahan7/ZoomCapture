import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Film, FolderDown, Image as ImageIcon, XCircle } from 'lucide-react';
import { downloadBlob } from '@/services/export/download';
import { CODEC_NAMES, probeCapabilities, type ExportCapabilities } from '@/services/export/capabilities';
import { describeExportError, isExporting, planProblem, plannedSize, runExport, type ExportFailure, type ExportOutcome, type ExportProgress } from '@/services/export/exportMedia';
import { canChooseFile, chooseFile, type FileTarget } from '@/services/export/saveTarget';
import {
  audioBitrate,
  estimateBytes,
  exportFileName,
  exportSettingsOf,
  FRAME_RATES,
  GIF_COLORS,
  GIF_FRAME_RATES,
  GIF_SIZES,
  gifDelayCs,
  gifFrameCount,
  gifRange,
  isStillFormat,
  isVideoFormat,
  LIMITS,
  memoryBudgetBytes,
  videoBitrate,
  type NormalizedExportSettings,
} from '@/services/export/settings';
import { audibleClips } from '@/services/render/audioMix';
import { clampCustomSize } from '@/services/render/enhancements';
import { RESOLUTION_HEIGHT } from '@/services/render/output';
import { getAssetBlob } from '@/services/storage/assetRepository';
import { contentDuration } from '@/services/timeline/model';
import { Button, Dialog, ProgressBar, SegmentedControl, Select, TextField, Toggle } from '@/shared/components';
import type { AspectRatio, ExportFormat, ExportSettings, GifExportSettings, MediaAsset, Project, Recording } from '@/types';
import { formatBytes, formatDuration } from '@/utils/format';
import { formatTimecode, parseTimecode, useEditor } from '../state/EditorContext';
import { logDiagnostic } from '@/services/diagnostics';

type Phase =
  | { name: 'setup' }
  | { name: 'running'; progress: ExportProgress | null; startedAt: number }
  | { name: 'done'; outcome: ExportOutcome; url: string | null }
  | { name: 'failed'; failure: ExportFailure };

const FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'mp4', label: 'MP4' },
  { value: 'webm', label: 'WebM' },
  { value: 'gif', label: 'GIF' },
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
];

const RESOLUTIONS: Array<{ value: ExportSettings['resolution']; label: string }> = [
  { value: 'source', label: 'Full size' },
  { value: '2160p', label: '2160p (4K)' },
  { value: '1440p', label: '1440p' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' },
];

const ASPECTS: Array<{ value: AspectRatio; label: string }> = [
  { value: 'source', label: 'Recording’s own' },
  { value: '16:9', label: '16:9 (landscape)' },
  { value: '9:16', label: '9:16 (vertical)' },
  { value: '1:1', label: '1:1 (square)' },
  { value: '4:3', label: '4:3' },
  { value: 'custom', label: 'Custom size' },
];

const QUALITY_LABELS: Record<ExportSettings['quality'], string> = { low: 'Low', standard: 'Standard', high: 'High', custom: 'Custom' };

/** A time field (m:ss.xx) that commits on Enter or blur. */
function TimeInput({ label, value, onCommit, testId }: { label: string; value: number; onCommit: (ms: number) => void; testId?: string }) {
  const [draft, setDraft] = useState(formatTimecode(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setDraft(formatTimecode(value)), [value]);
  const commit = () => {
    const ms = parseTimecode(draft);
    setInvalid(ms === null);
    if (ms !== null && ms !== value) onCommit(ms);
  };
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <input
        value={draft}
        data-testid={testId}
        aria-invalid={invalid || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === 'Enter' && commit()}
        className="h-9 w-full rounded-lg border border-line-strong bg-surface-2 px-2 font-mono text-sm"
      />
    </label>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="contents">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="min-w-0 truncate text-fg" title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Export: MP4 or WebM video, an animated GIF, or a PNG / JPEG of one frame. The settings and a
 * summary of the result are shown before anything is rendered; then progress, and the result to
 * download (or where it was saved). Every format is drawn by the same renderer as the preview.
 */
export function ExportDialog({
  open,
  mode,
  onClose,
  recording,
  project,
  assets,
  onSettingsChange,
}: {
  open: boolean;
  /** `still`: opened with "Save frame" (PNG / JPEG of the playhead). */
  mode: 'video' | 'still';
  onClose: () => void;
  recording: Recording;
  project: Project;
  assets: readonly MediaAsset[];
  onSettingsChange: (settings: ExportSettings) => void;
}) {
  const { store, playheadMs } = useEditor();
  const [phase, setPhase] = useState<Phase>({ name: 'setup' });
  const [capabilities, setCapabilities] = useState<ExportCapabilities | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [stillTimeMs, setStillTimeMs] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  const settings = exportSettingsOf(project.exportSettings);
  const hasCamera = Boolean(project.cameraLayout && assets.some((asset) => asset.kind === 'camera' && asset.origin === 'recording'));
  const source = { width: recording.width ?? 1920, height: recording.height ?? 1080 };
  const durationMs = contentDuration(project.timeline.tracks);
  const memoryBudget = useMemo(() => memoryBudgetBytes(), []);
  const audioTracks = useMemo(() => new Set(audibleClips(project.timeline, new Map(assets.map((asset) => [asset.id, asset]))).map(({ track }) => track.id)).size, [project.timeline, assets]);

  // Probed when the dialog first opens (only then is the encoder library loaded).
  useEffect(() => {
    if (!open || capabilities) return;
    probeCapabilities().then(setCapabilities, (error: unknown) => setProbeError(error instanceof Error ? error.message : String(error)));
  }, [open, capabilities]);

  // Opening for a still: the frame at the playhead, as an image.
  useEffect(() => {
    if (!open) return;
    setStillTimeMs(Math.round(playheadMs()));
    if (mode === 'still' && !isStillFormat(settings.format)) update({ format: 'png' });
    if (mode === 'video' && isStillFormat(settings.format)) update({ format: 'mp4' });
    // Only when it opens.
  }, [open, mode]);

  const releaseUrl = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  };

  // Leaving the page while exporting would lose the work: ask first.
  useEffect(() => {
    if (phase.name !== 'running') return;
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

  const update = (patch: Partial<ExportSettings>) => onSettingsChange({ ...project.exportSettings, ...patch });
  const updateGif = (patch: Partial<GifExportSettings>) => update({ gif: { ...settings.gif, ...patch } });

  const fileName = exportFileName(settings.fileName, recording.name, settings.format, isStillFormat(settings.format) ? ` (frame at ${(stillTimeMs / 1000).toFixed(2)} s)` : ' (edited)');
  const toFile = settings.saveTo === 'choose' && canChooseFile();
  const problem = planProblem({ project, recording }, settings, capabilities, toFile, memoryBudget);
  const size = plannedSize({ project, recording }, settings);
  const resolutions = RESOLUTIONS.filter((option) => option.value === 'source' || RESOLUTION_HEIGHT[option.value] < Math.min(size.width, size.height) || RESOLUTION_HEIGHT[option.value] < Math.min(source.width, source.height) || option.value === settings.resolution);

  const close = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    releaseUrl();
    setPhase({ name: 'setup' });
    onClose();
  };

  const start = async () => {
    if (phase.name === 'running' || isExporting() || !capabilities || problem) return;
    // Asked first, straight from the click (the browser requires it), before any work.
    let file: FileTarget | undefined;
    if (toFile) {
      try {
        file = await chooseFile(fileName, settings.format);
      } catch (error) {
        const failure = describeExportError(error);
        if (failure.kind !== 'cancelled') setPhase({ name: 'failed', failure });
        return;
      }
    }
    const controller = new AbortController();
    abortRef.current = controller;
    releaseUrl();
    setPhase({ name: 'running', progress: null, startedAt: performance.now() });
    try {
      await store.flush();
      const current = store.project;
      // The bytes of every asset used on the timeline, and the background image.
      const used = new Set(current.timeline.tracks.flatMap((track) => track.clips.flatMap((clip) => (clip.type === 'media' ? [clip.assetId] : []))));
      if (current.background?.kind === 'image' && current.background.imageAssetId) used.add(current.background.imageAssetId);
      const entries = await Promise.all([...used].map(async (id) => [id, await getAssetBlob(id)] as const));
      const blobs = new Map(entries.flatMap(([id, blob]) => (blob ? [[id, blob] as const] : [])));
      if (used.has(recording.screenAssetId) && !blobs.has(recording.screenAssetId)) throw new Error('The recording file is missing from local storage.');
      const outcome = await runExport({
        job: { recording, project: current, assets, blobs },
        settings: { ...settings, includeCamera: settings.includeCamera && hasCamera },
        capabilities,
        fileName: file?.name ?? fileName,
        file,
        stillTimeMs,
        signal: controller.signal,
        memoryBudget,
        onProgress: (progress) => {
          if (!controller.signal.aborted) setPhase((current) => (current.name === 'running' ? { ...current, progress } : current));
        },
      });
      if (controller.signal.aborted) return;
      const blob = outcome.blob ?? (file ? await file.file() : null);
      const url = blob ? URL.createObjectURL(blob) : null;
      urlRef.current = url;
      setPhase({ name: 'done', outcome, url });
    } catch (error) {
      const failure = describeExportError(controller.signal.aborted ? new DOMException('Cancelled', 'AbortError') : error);
      if (failure.kind !== 'cancelled' && failure.kind !== 'busy') logDiagnostic(`export:${settings.format}:${failure.kind}`, error);
      // Closing the dialog cancels quietly; the Cancel button shows that nothing was saved.
      if (abortRef.current === controller || failure.kind !== 'cancelled') setPhase({ name: 'failed', failure });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  // "Cancel export" appears where "Start export" was: the second click of a double-click must not cancel.
  const cancel = () => {
    if (phase.name === 'running' && performance.now() - phase.startedAt < 700) return;
    abortRef.current?.abort();
  };

  const title = isStillFormat(settings.format) ? 'Export image' : settings.format === 'gif' ? 'Export GIF' : 'Export video';
  const running = phase.name === 'running';

  return (
    <Dialog
      open={open}
      onClose={running ? cancel : close}
      size={phase.name === 'done' || phase.name === 'setup' ? 'lg' : 'md'}
      title={title}
      description="Renders the edited timeline (clips, images and pages, zoom effects, camera, text, watermarks, subtitles and audio) exactly as the preview shows it. The original recording is not changed."
      footer={
        phase.name === 'setup' ? (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" icon={isStillFormat(settings.format) ? ImageIcon : Film} disabled={!capabilities || Boolean(problem)} onClick={() => void start()}>
              {toFile ? 'Choose file and export' : 'Start export'}
            </Button>
          </>
        ) : running ? (
          <Button variant="ghost" onClick={cancel}>
            Cancel export
          </Button>
        ) : phase.name === 'failed' ? (
          <>
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
            <Button variant="primary" onClick={() => setPhase({ name: 'setup' })}>
              {phase.failure.kind === 'cancelled' ? 'Back to settings' : 'Change settings and try again'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
            {phase.outcome.blob ? (
              <Button variant="primary" icon={Download} onClick={() => downloadBlob(phase.outcome.blob!, phase.outcome.fileName)}>
                Download
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setPhase({ name: 'setup' })}>
                Export again
              </Button>
            )}
          </>
        )
      }
    >
      {phase.name === 'setup' && (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,15rem)]">
          <div className="space-y-4">
            <div>
              <p className="mb-1.5 text-sm font-medium">Format</p>
              <SegmentedControl label="Format" options={FORMATS} value={settings.format} onChange={(format) => update({ format })} />
            </div>
            <Select
              label="Aspect ratio"
              description="Same as the editor’s; changing it here changes the project."
              options={ASPECTS}
              value={project.aspectRatio}
              onValueChange={(value) => {
                const aspectRatio = value as AspectRatio;
                store.edit('Change aspect ratio', (p) => ({
                  ...p,
                  aspectRatio,
                  customSize: aspectRatio === 'custom' ? (p.customSize ?? clampCustomSize(source)) : p.customSize,
                }));
              }}
            />

            {isVideoFormat(settings.format) && (
              <>
                <Select label="Resolution" description={`${size.width}×${size.height}`} options={resolutions} value={settings.resolution} onValueChange={(value) => update({ resolution: value as ExportSettings['resolution'] })} />
                <div>
                  <p className="mb-1.5 text-sm font-medium">Frame rate</p>
                  <SegmentedControl label="Frame rate" options={FRAME_RATES.map((value) => ({ value, label: `${value} fps` }))} value={settings.frameRate} onChange={(frameRate) => update({ frameRate })} />
                </div>
                <div>
                  <p className="mb-1.5 text-sm font-medium">Quality</p>
                  <SegmentedControl
                    label="Quality"
                    options={(['low', 'standard', 'high', 'custom'] as const).map((value) => ({ value, label: QUALITY_LABELS[value] }))}
                    value={settings.quality}
                    onChange={(quality) => update({ quality })}
                  />
                </div>
                {settings.quality === 'custom' && (
                  <TextField
                    label="Video bitrate (Mbps)"
                    type="number"
                    min={LIMITS.bitrateMbps.min}
                    max={LIMITS.bitrateMbps.max}
                    step={0.5}
                    value={String(settings.bitrateMbps)}
                    onValueChange={(value) => update({ bitrateMbps: Number(value) })}
                  />
                )}
              </>
            )}

            {settings.format === 'gif' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Select label="Size (longest side)" description={`${size.width}×${size.height}`} options={GIF_SIZES.map((value) => ({ value: String(value), label: `${value} px` }))} value={String(settings.gif.size)} onValueChange={(value) => updateGif({ size: Number(value) })} />
                  <Select label="Frame rate" options={GIF_FRAME_RATES.map((value) => ({ value: String(value), label: `${value} fps` }))} value={String(settings.gif.frameRate)} onValueChange={(value) => updateGif({ frameRate: Number(value) as GifExportSettings['frameRate'] })} />
                </div>
                <div>
                  <p className="mb-1.5 text-sm font-medium">Quality (colours)</p>
                  <SegmentedControl label="Colours" options={GIF_COLORS.map((value) => ({ value, label: value === 64 ? 'Small (64)' : value === 128 ? 'Medium (128)' : 'Best (256)' }))} value={settings.gif.colors} onChange={(colors) => updateGif({ colors })} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <TimeInput label="From" testId="gif-start" value={gifRange(settings.gif, durationMs).startMs} onCommit={(startMs) => updateGif({ startMs })} />
                  <TimeInput label="To" testId="gif-end" value={gifRange(settings.gif, durationMs).endMs} onCommit={(endMs) => updateGif({ endMs: endMs >= durationMs ? null : endMs })} />
                </div>
                <Toggle label="Dithering" description="Smoother gradients and video; larger file" checked={settings.gif.dither} onCheckedChange={(dither) => updateGif({ dither })} />
                <Toggle label="Loop forever" checked={settings.gif.loop} onCheckedChange={(loop) => updateGif({ loop })} />
              </>
            )}

            {isStillFormat(settings.format) && (
              <>
                <Select label="Resolution" description={`${size.width}×${size.height}`} options={resolutions} value={settings.resolution} onValueChange={(value) => update({ resolution: value as ExportSettings['resolution'] })} />
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <TimeInput label="Frame at" testId="still-time" value={stillTimeMs} onCommit={(ms) => setStillTimeMs(Math.min(ms, Math.max(0, durationMs - 1)))} />
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setStillTimeMs(Math.round(playheadMs()))}>
                    Use playhead
                  </Button>
                </div>
                {settings.format === 'jpeg' && (
                  <label className="block text-sm">
                    <span className="mb-1 flex justify-between font-medium">
                      JPEG quality <output className="font-mono text-fg-muted">{Math.round(settings.jpegQuality * 100)} %</output>
                    </span>
                    <input
                      type="range"
                      min={LIMITS.jpegQuality.min}
                      max={LIMITS.jpegQuality.max}
                      step={0.01}
                      value={settings.jpegQuality}
                      onChange={(event) => update({ jpegQuality: Number(event.target.value) })}
                      className="w-full accent-[var(--color-accent)]"
                    />
                  </label>
                )}
              </>
            )}

            {hasCamera && <Toggle label="Include camera bubble" checked={settings.includeCamera} onCheckedChange={(includeCamera) => update({ includeCamera })} />}

            <TextField label="File name" placeholder={exportFileName('', recording.name, settings.format, isStillFormat(settings.format) ? '' : ' (edited)')} value={settings.fileName} onValueChange={(value) => update({ fileName: value })} />
            <div>
              <p className="mb-1.5 text-sm font-medium">Save to</p>
              <SegmentedControl
                label="Save to"
                options={[
                  { value: 'downloads', label: 'Downloads folder' },
                  { value: 'choose', label: canChooseFile() ? 'A file I choose' : 'A file I choose (not available)' },
                ]}
                value={toFile ? 'choose' : 'downloads'}
                onChange={(saveTo) => canChooseFile() && update({ saveTo })}
              />
              <p className="mt-1 text-xs text-fg-subtle">
                {toFile
                  ? 'You pick the name and folder first; the file is written as it is made, so long videos don’t need to fit in memory.'
                  : `The file is made in memory (up to ${formatBytes(memoryBudget)}), then downloaded with your browser’s download settings.`}
              </p>
            </div>
          </div>

          <ExportSummary settings={settings} capabilities={capabilities} probeError={probeError} project={project} size={size} durationMs={durationMs} stillTimeMs={stillTimeMs} audioTracks={audioTracks} fileName={fileName} toFile={toFile} problem={problem} />
        </div>
      )}

      {phase.name === 'running' && <ExportProgressView phase={phase} format={settings.format} />}

      {phase.name === 'failed' && (
        <div role="alert" className={phase.failure.kind === 'cancelled' ? 'flex gap-2 rounded-lg bg-surface-2 p-3 text-sm' : 'flex gap-2 rounded-lg bg-rec/10 p-3 text-sm text-rec'} data-testid="export-failure" data-kind={phase.failure.kind}>
          {phase.failure.kind === 'cancelled' ? <XCircle size={16} aria-hidden className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0" />}
          <div>
            <p>{phase.failure.kind === 'cancelled' ? phase.failure.message : `Export failed: ${phase.failure.message}`}</p>
            {phase.failure.hint && <p className="mt-1 text-fg-muted">{phase.failure.hint}</p>}
          </div>
        </div>
      )}

      {phase.name === 'done' && <ExportResult outcome={phase.outcome} url={phase.url} />}
    </Dialog>
  );
}

function ExportSummary({
  settings,
  capabilities,
  probeError,
  project,
  size,
  durationMs,
  stillTimeMs,
  audioTracks,
  fileName,
  toFile,
  problem,
}: {
  settings: NormalizedExportSettings;
  capabilities: ExportCapabilities | null;
  probeError: string | null;
  project: Project;
  size: { width: number; height: number };
  durationMs: number;
  stillTimeMs: number;
  audioTracks: number;
  fileName: string;
  toFile: boolean;
  problem: string | null;
}) {
  const format = settings.format;
  const video = isVideoFormat(format);
  const videoCodec = video ? capabilities?.[format].video[0] : undefined;
  const audioCodec = video ? capabilities?.[format].audio[0] : undefined;
  const range = gifRange(settings.gif, durationMs);
  const gifFrames = gifFrameCount(range, settings.gif.frameRate);
  const estimate = estimateBytes(settings, { size, durationSeconds: durationMs / 1000, videoCodec, hasAudio: audioTracks > 0 && Boolean(audioCodec), gifFrames });
  const rows: Array<[string, string]> = [];
  if (video) {
    rows.push(['Format', `${format === 'mp4' ? 'MP4' : 'WebM'} · ${videoCodec ? CODEC_NAMES[videoCodec] : '…'}${audioTracks > 0 && audioCodec ? ` + ${CODEC_NAMES[audioCodec]}` : ''}`]);
    rows.push(['Encoder', 'WebCodecs (hardware when available)']);
    rows.push(['Size', `${size.width}×${size.height} · ${project.aspectRatio === 'source' ? 'recording’s shape' : project.aspectRatio}`]);
    rows.push(['Frame rate', `${settings.frameRate} fps`]);
    rows.push(['Length', `${formatDuration(durationMs)} · ${Math.ceil((durationMs / 1000) * settings.frameRate)} frames`]);
    const bitrate = videoBitrate(settings, size, videoCodec ?? 'avc');
    rows.push(['Quality', `${QUALITY_LABELS[settings.quality]} · ${(bitrate / 1_000_000).toFixed(1)} Mbps`]);
    rows.push(['Audio', audioTracks === 0 ? 'None on the timeline' : audioCodec ? `${audioTracks} track${audioTracks === 1 ? '' : 's'} mixed · ${audioBitrate(settings.quality) / 1000} kbps` : 'Not available (no audio encoder)']);
  } else if (format === 'gif') {
    rows.push(['Format', 'Animated GIF (GIF89a)']);
    rows.push(['Size', `${size.width}×${size.height}`]);
    rows.push(['Frame rate', `${(100 / gifDelayCs(settings.gif.frameRate)).toFixed(1).replace(/\.0$/, '')} fps · ${gifFrames} frames`]);
    rows.push(['Part', `${formatTimecode(range.startMs)}–${formatTimecode(range.endMs)} (${formatDuration(range.endMs - range.startMs)})`]);
    rows.push(['Colours', `${settings.gif.colors}${settings.gif.dither ? ', dithered' : ''} · ${settings.gif.loop ? 'loops' : 'plays once'}`]);
    rows.push(['Audio', 'None (GIFs have no sound)']);
  } else {
    rows.push(['Format', format === 'png' ? 'PNG (lossless)' : `JPEG · ${Math.round(settings.jpegQuality * 100)} %`]);
    rows.push(['Size', `${size.width}×${size.height}`]);
    rows.push(['Frame', formatTimecode(stillTimeMs)]);
  }
  // Encoders spend fewer bits on still screens: videos and GIFs usually come out smaller.
  rows.push(['Estimated size', `${isStillFormat(format) ? 'about' : 'up to about'} ${formatBytes(estimate)}`]);
  rows.push(['File', fileName]);
  rows.push(['Saved to', toFile ? 'A file you choose next' : 'Downloads (browser settings)']);
  return (
    <section aria-label="Export summary" data-testid="export-summary" className="space-y-3 rounded-xl border border-line bg-surface-2 p-3 text-xs">
      <h3 className="text-sm font-semibold">Summary</h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        {rows.map(([label, value]) => (
          <SummaryRow key={label} label={label} value={value} />
        ))}
      </dl>
      {!capabilities && !probeError && <p className="text-fg-subtle">Checking what this browser can encode…</p>}
      {probeError && <p className="text-rec">Couldn’t check the encoders: {probeError}</p>}
      {problem && (
        <p role="alert" className="flex gap-1.5 rounded-lg bg-warning/10 p-2 text-warning" data-testid="export-problem">
          <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
          {problem}
        </p>
      )}
    </section>
  );
}

function ExportProgressView({ phase, format }: { phase: Extract<Phase, { name: 'running' }>; format: ExportFormat }) {
  const { progress } = phase;
  const elapsed = (performance.now() - phase.startedAt) / 1000;
  const remaining = progress && progress.stage === 'rendering' && progress.fraction > 0.03 ? (elapsed / progress.fraction) * (1 - progress.fraction) : null;
  const text = !progress
    ? 'Preparing…'
    : progress.stage === 'preparing'
      ? format === 'gif'
        ? 'Choosing the colours…'
        : 'Checking the media…'
      : progress.stage === 'finalizing'
        ? 'Finishing the file…'
        : progress.frames
          ? `Rendering frame ${progress.frame} of ${progress.frames} (${Math.round(progress.fraction * 100)} %)`
          : 'Rendering…';
  return (
    <div className="space-y-2" aria-live="polite" data-testid="export-progress">
      <ProgressBar value={progress?.stage === 'rendering' || progress?.stage === 'finalizing' ? progress.fraction : 0} label="Export progress" />
      <p className="text-sm text-fg-muted">
        {text}
        {remaining !== null && remaining > 2 && ` · about ${formatDuration(remaining * 1000)} left`}
      </p>
      <p className="text-xs text-fg-subtle">Keep this tab open until the export finishes. Cancelling saves nothing.</p>
    </div>
  );
}

function ExportResult({ outcome, url }: { outcome: ExportOutcome; url: string | null }) {
  const video = isVideoFormat(outcome.format);
  const details = [
    `${outcome.width}×${outcome.height}`,
    outcome.frameRate ? `${Number(outcome.frameRate.toFixed(2))} fps` : null,
    outcome.durationSeconds !== undefined ? formatDuration(outcome.durationSeconds * 1000) : null,
    outcome.codecs ?? null,
    outcome.format === 'gif' ? `${outcome.frames} frames` : null,
    outcome.timeMs !== undefined ? `frame at ${formatTimecode(outcome.timeMs)}` : null,
    video ? (outcome.audio === 'none' ? 'no audio' : 'audio mixed') : null,
    formatBytes(outcome.bytes),
  ].filter(Boolean);
  return (
    <div className="space-y-3" data-testid="export-result" data-format={outcome.format}>
      {url &&
        (video ? (
          <video src={url} controls playsInline data-testid="rendered-video" aria-label="Exported video" className="aspect-video w-full rounded-xl bg-black object-contain" />
        ) : (
          <img src={url} alt="Exported image" data-testid="rendered-image" className="max-h-[50vh] w-full rounded-xl bg-black object-contain" />
        ))}
      <p className="flex items-center gap-1.5 text-sm text-success">
        {outcome.savedTo === 'file' ? <FolderDown size={15} aria-hidden /> : <CheckCircle2 size={15} aria-hidden />}
        {outcome.savedTo === 'file' ? `Saved as “${outcome.fileName}”.` : `Ready: “${outcome.fileName}”.`}
      </p>
      <p className="text-sm text-fg-muted" data-testid="render-summary">
        {details.join(' · ')}
      </p>
      {outcome.warnings.map((warning) => (
        <p key={warning} className="flex gap-2 rounded-lg bg-warning/10 p-2.5 text-xs text-warning">
          <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
          {warning}
        </p>
      ))}
    </div>
  );
}
