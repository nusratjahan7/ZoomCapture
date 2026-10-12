import { useEffect, useState } from 'react';
import {
  AudioLines,
  CheckCircle2,
  Download,
  Monitor,
  PencilLine,
  PencilRuler,
  RotateCcw,
  Trash2,
  TriangleAlert,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { sendMessage } from '@/services/messaging';
import { describeMimeType } from '@/services/recording/mimeTypes';
import { getRecordingDetails, type RecordingDetails } from '@/services/storage/recordingRepository';
import { Button, EmptyState, Panel } from '@/shared/components';
import { useAssetUrl } from '@/shared/hooks/useAssetUrl';
import { useRecordingActions } from '@/shared/hooks/useRecordingActions';
import type { MediaAssetKind } from '@/types';
import { describeStorageError } from '@/utils/storageErrors';
import { formatBytes, formatDuration } from '@/utils/format';

const KIND_INFO: Partial<Record<MediaAssetKind, { label: string; icon: LucideIcon }>> = {
  screen: { label: 'Screen', icon: Monitor },
  camera: { label: 'Camera', icon: Video },
  microphone: { label: 'Microphone', icon: AudioLines },
  'system-audio': { label: 'Tab / system audio', icon: AudioLines },
};

/** Shown after a recording is saved: preview, rename, download, delete and next steps. */
export function RecordingResult({ recordingId, onRecordAgain }: { recordingId: string; onRecordAgain: () => void }) {
  const [details, setDetails] = useState<RecordingDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const { url: videoUrl } = useAssetUrl(deleted ? undefined : details?.recording.screenAssetId);
  const actions = useRecordingActions({
    onRenamed: (recording) => setDetails((current) => current && { ...current, recording }),
    onDeleted: () => setDeleted(true),
  });

  useEffect(() => {
    getRecordingDetails(recordingId).then(
      (value) => (value ? setDetails(value) : setError('This recording no longer exists.')),
      (err: unknown) => setError(describeStorageError(err)),
    );
  }, [recordingId]);

  if (deleted || error) {
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          icon={deleted ? Trash2 : TriangleAlert}
          title={deleted ? 'Recording deleted' : 'Could not open the recording'}
          description={deleted ? 'It was permanently removed from this browser.' : (error ?? undefined)}
          action={
            <Button variant="primary" icon={RotateCcw} onClick={onRecordAgain}>
              Record again
            </Button>
          }
        />
        {actions.dialogs}
      </main>
    );
  }

  const recording = details?.recording;
  const originals = details?.assets.filter((asset) => asset.origin === 'recording') ?? [];
  const interrupted = originals.filter((asset) => asset.endedEarly);

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
        <Panel
          title={recording?.name ?? 'Recording'}
          actions={
            recording && (
              <Button size="sm" variant="ghost" icon={PencilLine} onClick={() => actions.rename(recording)}>
                Rename
              </Button>
            )
          }
        >
          <dl className="space-y-2.5 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-fg-subtle">Duration</dt>
              <dd>{formatDuration(recording?.durationMs ?? 0)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-fg-subtle">Format</dt>
              <dd>{recording ? describeMimeType(recording.mimeType) : '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-fg-subtle">Resolution</dt>
              <dd>{recording?.width && recording.height ? `${recording.width}×${recording.height}` : '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-fg-subtle">Size</dt>
              <dd>{formatBytes(recording?.sizeBytes ?? 0)}</dd>
            </div>
          </dl>
          <h3 className="mt-4 mb-2 text-xs font-semibold tracking-wider text-fg-subtle uppercase">Recorded tracks</h3>
          <ul className="space-y-1.5">
            {originals.map((asset) => {
              const info = KIND_INFO[asset.kind];
              if (!info) return null;
              const Icon = info.icon;
              return (
                <li key={asset.id} className="flex items-center gap-2 text-sm">
                  <Icon size={14} aria-hidden className="text-fg-subtle" />
                  <span className="flex-1 truncate" title={asset.label}>
                    {info.label}
                  </span>
                  <span className="text-xs text-fg-subtle">{formatBytes(asset.size)}</span>
                </li>
              );
            })}
          </ul>
          {interrupted.length > 0 && (
            <p className="mt-3 flex gap-2 rounded-lg bg-warning/10 p-2 text-xs text-warning">
              <TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />
              {interrupted.map((asset) => KIND_INFO[asset.kind]?.label).join(', ')} stopped before the recording ended.
            </p>
          )}
        </Panel>

        <div className="space-y-2">
          <Button
            variant="primary"
            fullWidth
            icon={Download}
            disabled={!recording}
            onClick={() => recording && void actions.download(recording)}
          >
            Download
          </Button>
          <Button
            fullWidth
            icon={PencilRuler}
            onClick={() => void sendMessage('page/open', { page: 'editor', params: { recording: recordingId } })}
          >
            Open in editor
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" icon={RotateCcw} onClick={onRecordAgain}>
              Record again
            </Button>
            <Button variant="ghost" icon={Trash2} disabled={!recording} onClick={() => recording && actions.remove(recording)}>
              Delete
            </Button>
          </div>
        </div>
      </aside>
      {actions.dialogs}
    </main>
  );
}
