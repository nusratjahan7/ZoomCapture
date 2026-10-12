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
import { notifyLibraryChanged, subscribeLibrary } from '@/services/storage/libraryEvents';
import { getRecordingDetails, type RecordingDetails } from '@/services/storage/recordingRepository';
import { Button, buttonClassName, ConfirmDialog, EmptyState, IconButton, Panel, useToast, type ToastOptions } from '@/shared/components';
import { updateZoomMarkers } from '@/services/storage/projectRepository';
import {
  createMarker,
  deleteMarker,
  duplicateMarker,
  regenerateAutoMarkers,
  sortMarkers,
  updateMarker,
  type MarkerPatch,
} from '@/services/zoom/markers';
import { useAssetUrl } from '@/shared/hooks/useAssetUrl';
import { useRecordingActions } from '@/shared/hooks/useRecordingActions';
import type { MediaAsset, MediaAssetKind, ZoomMarker } from '@/types';
import { formatBytes, formatDuration } from '@/utils/format';
import { describeStorageError } from '@/utils/storageErrors';
import { EditorHeader } from './EditorHeader';
import { TimelineView } from './TimelineView';
import { ZoomEffectsPanel } from './ZoomEffectsPanel';
import { ZoomMarkerDialog } from './ZoomMarkerDialog';
import { useVideoTime, ZoomPreview } from './ZoomPreview';

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
  const { recording, assets } = details;
  const toast = useToast();
  const actions = useRecordingActions({ onDeleted: () => window.location.replace('index.html') });
  const cameraAsset = assets.find((asset) => asset.kind === 'camera' && asset.origin === 'recording');
  const { url: videoUrl } = useAssetUrl(recording.screenAssetId);
  const { url: cameraUrl } = useAssetUrl(details.project.cameraLayout ? cameraAsset?.id : undefined);
  const mainRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<HTMLVideoElement>(null);
  const [downloading, setDownloading] = useState(false);
  useFollowerSync(mainRef, cameraRef, cameraAsset?.startOffsetMs ?? 0, Boolean(videoUrl && cameraUrl));
  const { url: thumbnailUrl } = useAssetUrl(recording.thumbnailAssetId);
  const { ms: playheadMs } = useVideoTime(mainRef, Boolean(videoUrl));

  // Zoom markers are edited optimistically against the stored project (one transaction per edit).
  const [project, setProject] = useState(details.project);
  useEffect(() => setProject(details.project), [details.project]);
  const markers = project.timeline.zoomMarkers;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ZoomMarker | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(true);
  const durationMs = recording.durationMs;
  const aspectRatio = recording.width && recording.height ? recording.width / recording.height : 16 / 9;

  const changeMarkers = async (change: (current: ZoomMarker[]) => ZoomMarker[], success?: ToastOptions) => {
    setBusy(true);
    try {
      const updated = await updateZoomMarkers(project.id, (current) => change(current));
      setProject(updated);
      notifyLibraryChanged({ type: 'project', recordingId: recording.id });
      if (success) toast.show(success);
      return updated;
    } catch (error) {
      toast.show({ variant: 'error', title: 'Could not save the zoom effect', description: describeStorageError(error) });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const seekTo = (ms: number) => {
    const video = mainRef.current;
    if (video) video.currentTime = Math.max(0, Math.min(durationMs, ms)) / 1000;
  };

  const selectMarker = (marker: ZoomMarker) => {
    setSelectedId(marker.id);
    seekTo(marker.timeMs);
  };

  const addAtPlayhead = async () => {
    const created = createMarker({ timeMs: (mainRef.current?.currentTime ?? 0) * 1000 }, project.zoom, durationMs);
    const updated = await changeMarkers((current) => sortMarkers([...current, created]), { variant: 'success', title: 'Zoom effect added' });
    if (updated) {
      setSelectedId(created.id);
      setEditing(created);
    }
  };

  const saveMarker = async (id: string, patch: MarkerPatch) => {
    const updated = await changeMarkers((current) => updateMarker(current, id, patch, durationMs), {
      variant: 'success',
      title: 'Zoom effect saved',
    });
    if (!updated) throw new Error('not saved');
  };

  const duplicate = async (marker: ZoomMarker) => {
    let copyId = '';
    await changeMarkers(
      (current) => {
        const result = duplicateMarker(current, marker.id, durationMs);
        copyId = result.copy.id;
        return result.markers;
      },
      { variant: 'success', title: 'Zoom effect duplicated' },
    );
    if (copyId) setSelectedId(copyId);
  };

  const remove = async (marker: ZoomMarker) => {
    const removed = await changeMarkers((current) => deleteMarker(current, marker.id));
    if (!removed) return;
    if (selectedId === marker.id) setSelectedId(null);
    toast.show({
      title: 'Zoom effect deleted',
      action: {
        label: 'Undo',
        onClick: () => void changeMarkers((current) => sortMarkers([...deleteMarker(current, marker.id), marker])),
      },
    });
  };

  const regenerate = async () => {
    await changeMarkers((current) => regenerateAutoMarkers(current, recording.interactions, project.zoom, durationMs), {
      variant: 'success',
      title: 'Zoom effects generated from clicks',
      description: 'Effects you added or edited were kept.',
    });
  };

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
    ['Click tracking', recording.clickTracking.mode === 'tab' ? `${recording.interactions.length} clicks` : 'Not available'],
  ];

  const layout = project.cameraLayout;
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
            <ZoomPreview
              videoUrl={videoUrl}
              cameraUrl={cameraUrl}
              cameraLayout={layout}
              aspectRatio={aspectRatio}
              markers={markers}
              interactions={recording.interactions}
              selectedMarker={markers.find((marker) => marker.id === selectedId) ?? null}
              previewZoom={previewZoom}
              onPreviewZoomChange={setPreviewZoom}
              videoRef={mainRef}
              cameraRef={cameraRef}
              label={`${recording.name} recording`}
            />
          </Panel>
          <TimelineView
            timeline={project.timeline}
            interactions={recording.interactions}
            currentMs={playheadMs}
            selectedMarkerId={selectedId}
            onSeek={seekTo}
            onMarkerSelect={(id) => {
              const marker = markers.find((candidate) => candidate.id === id);
              if (marker) {
                selectMarker(marker);
                setEditing(marker);
              }
            }}
          />
          <ZoomEffectsPanel
            markers={markers}
            clicks={recording.interactions.length}
            clickTracking={recording.clickTracking}
            selectedId={selectedId}
            busy={busy}
            onAdd={() => void addAtPlayhead()}
            onEdit={(marker) => {
              selectMarker(marker);
              setEditing(marker);
            }}
            onDuplicate={(marker) => void duplicate(marker)}
            onDelete={(marker) => void remove(marker)}
            onToggle={(marker, enabled) => void changeMarkers((current) => updateMarker(current, marker.id, { enabled }, durationMs))}
            onRegenerate={() => setConfirmRegenerate(true)}
            onSelect={selectMarker}
          />
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
      <ZoomMarkerDialog
        marker={editing}
        durationMs={durationMs}
        thumbnailUrl={thumbnailUrl}
        aspectRatio={aspectRatio}
        onClose={() => setEditing(null)}
        onSave={saveMarker}
      />
      <ConfirmDialog
        open={confirmRegenerate}
        onClose={() => setConfirmRegenerate(false)}
        onConfirm={regenerate}
        title="Generate zoom effects from clicks?"
        description={`Automatic effects are recreated from the ${recording.interactions.length} tracked clicks using this project's zoom defaults. Effects you added or edited are kept.`}
        confirmLabel="Generate effects"
      />
    </div>
  );
}
