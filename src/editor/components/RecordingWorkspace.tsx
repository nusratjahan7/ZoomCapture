import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  ArrowLeft,
  AudioLines,
  Download,
  FileQuestion,
  Film,
  Image,
  Loader2,
  Monitor,
  PencilLine,
  Trash2,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { downloadBlob } from '@/services/export/download';
import { assetFileName } from '@/services/export/exporters';
import { describeMimeType } from '@/services/recording/mimeTypes';
import { getAssetBlob } from '@/services/storage/assetRepository';
import { subscribeLibrary } from '@/services/storage/libraryEvents';
import { getRecordingDetails, type RecordingDetails } from '@/services/storage/recordingRepository';
import { Button, buttonClassName, EmptyState, IconButton, Panel, useToast } from '@/shared/components';
import { useAssetUrl } from '@/shared/hooks/useAssetUrl';
import { useRecordingActions } from '@/shared/hooks/useRecordingActions';
import { CAMERA_BUBBLE_SCALE, type MediaAsset, type MediaAssetKind } from '@/types';
import { formatBytes, formatDuration } from '@/utils/format';
import { describeStorageError } from '@/utils/storageErrors';
import { EditorHeader } from './EditorHeader';
import { TimelineView } from './TimelineView';

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; details: RecordingDetails };

const ASSET_INFO: Record<MediaAssetKind, { label: string; icon: LucideIcon }> = {
  screen: { label: 'Screen + mixed audio', icon: Monitor },
  camera: { label: 'Camera', icon: Video },
  microphone: { label: 'Microphone', icon: AudioLines },
  'system-audio': { label: 'Tab / system audio', icon: AudioLines },
  thumbnail: { label: 'Thumbnail', icon: Image },
  image: { label: 'Image', icon: Image },
  audio: { label: 'Audio', icon: AudioLines },
  video: { label: 'Video', icon: Film },
};

/** Loads a recording and reloads it when another page renames or deletes it. */
function useRecordingDetails(recordingId: string): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    const load = () =>
      getRecordingDetails(recordingId).then(
        (details) => active && setState(details ? { status: 'ready', details } : { status: 'missing' }),
        (error: unknown) => active && setState({ status: 'error', message: describeStorageError(error) }),
      );
    void load();
    const unsubscribe = subscribeLibrary((change) => {
      if ('recordingId' in change && change.recordingId === recordingId) void load();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [recordingId]);
  return state;
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
    All recordings
  </a>
);

export function RecordingWorkspace({ recordingId }: { recordingId: string }) {
  const state = useRecordingDetails(recordingId);

  if (state.status !== 'ready') {
    return (
      <div className="min-h-screen">
        <EditorHeader />
        <main className="flex min-h-[70vh] items-center justify-center p-6">
          {state.status === 'loading' ? (
            <Loader2 size={28} aria-label="Loading recording" className="animate-spin text-fg-subtle" />
          ) : (
            <EmptyState
              icon={FileQuestion}
              title={state.status === 'missing' ? 'Recording not found' : 'Could not open this recording'}
              description={state.status === 'missing' ? 'It may have been deleted from this browser.' : state.message}
              action={backLink}
            />
          )}
        </main>
      </div>
    );
  }

  return <Workspace details={state.details} />;
}

function Workspace({ details }: { details: RecordingDetails }) {
  const { recording, project, assets } = details;
  const toast = useToast();
  const actions = useRecordingActions({ onDeleted: () => window.location.replace('index.html') });
  const cameraAsset = assets.find((asset) => asset.kind === 'camera' && asset.origin === 'recording');
  const { url: videoUrl } = useAssetUrl(recording.screenAssetId);
  const { url: cameraUrl } = useAssetUrl(project.cameraLayout ? cameraAsset?.id : undefined);
  const mainRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<HTMLVideoElement>(null);
  const [downloading, setDownloading] = useState(false);
  useFollowerSync(mainRef, cameraRef, cameraAsset?.startOffsetMs ?? 0, Boolean(videoUrl && cameraUrl));

  useEffect(() => {
    document.title = `${recording.name} · ZoomCapture`;
  }, [recording.name]);

  const downloadAsset = async (asset: MediaAsset) => {
    try {
      const blob = await getAssetBlob(asset.id);
      if (!blob) throw new Error('This file is missing from local storage.');
      downloadBlob(blob, assetFileName(recording, asset));
    } catch (error) {
      toast.show({ variant: 'error', title: 'Download failed', description: describeStorageError(error) });
    }
  };

  const facts: Array<[string, string]> = [
    ['Duration', formatDuration(recording.durationMs)],
    ['Recorded', new Date(recording.createdAt).toLocaleString()],
    ['Size', formatBytes(recording.sizeBytes)],
    ['Format', describeMimeType(recording.mimeType)],
    ['Resolution', recording.width && recording.height ? `${recording.width}×${recording.height}` : '—'],
    ['Source', recording.source?.label ?? '—'],
    ['Zoom markers', String(project.timeline.zoomMarkers.length)],
  ];

  const layout = project.cameraLayout;
  const bubbleWidth = layout ? CAMERA_BUBBLE_SCALE[layout.size] * 100 : 0;
  const mediaFiles = assets.filter((asset) => asset.kind !== 'thumbnail');

  return (
    <div className="flex min-h-screen flex-col">
      <EditorHeader>
        {backLink}
        <Button
          variant="primary"
          size="sm"
          icon={Download}
          loading={downloading}
          onClick={() => {
            setDownloading(true);
            void actions.download(recording).finally(() => setDownloading(false));
          }}
        >
          Download
        </Button>
      </EditorHeader>
      <main className="mx-auto grid w-full max-w-7xl flex-1 gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-2">
            <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{recording.name}</h1>
            <IconButton icon={PencilLine} label="Rename recording" size="sm" onClick={() => actions.rename(recording)} />
            <IconButton icon={Trash2} label="Delete recording" size="sm" tone="danger" onClick={() => actions.remove(recording)} />
          </div>
          <Panel className="p-3">
            <div className="relative aspect-video overflow-hidden rounded-xl border border-line bg-black">
              {videoUrl ? (
                <>
                  <video ref={mainRef} src={videoUrl} controls className="h-full w-full" aria-label={`${recording.name} recording`} />
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
                  <Loader2 size={24} aria-label="Loading video" className="animate-spin text-fg-subtle" />
                </div>
              )}
            </div>
          </Panel>
          <TimelineView timeline={project.timeline} />
        </div>

        <div className="space-y-4">
          <Panel as="aside" title="Recording details">
            <dl className="space-y-3 text-sm">
              {facts.map(([term, value]) => (
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
            <ul className="space-y-2">
              {mediaFiles.map((asset) => {
                const { label, icon: Icon } = ASSET_INFO[asset.kind];
                return (
                  <li key={asset.id} className="flex items-center gap-3 rounded-xl bg-surface-2 p-2.5">
                    <Icon size={16} aria-hidden className="shrink-0 text-fg-subtle" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" title={asset.label}>
                        {label}
                      </p>
                      <p className="truncate text-xs text-fg-subtle">
                        {describeMimeType(asset.mimeType)} · {formatDuration(asset.durationMs ?? 0)} · {formatBytes(asset.size)}
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
          </Panel>
        </div>
      </main>
      {actions.dialogs}
    </div>
  );
}
