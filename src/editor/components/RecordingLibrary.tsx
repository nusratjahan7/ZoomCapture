import { CalendarDays, Download, Film, HardDrive, PencilLine, Play, Trash2 } from 'lucide-react';
import { sendMessage } from '@/services/messaging';
import { Button, EmptyState, IconButton, RecordingThumbnail, useToast } from '@/shared/components';
import { useRecordingActions } from '@/shared/hooks/useRecordingActions';
import { useRecordings } from '@/shared/hooks/useRecordings';
import { useSettings } from '@/shared/hooks/useSettings';
import type { Recording } from '@/types';
import { getErrorMessage } from '@/utils/errors';
import { formatBytes, formatRelativeTime } from '@/utils/format';
import { EditorHeader } from './EditorHeader';
import { RecoverableRecordings } from './RecoverableRecordings';

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function RecordingCard({
  recording,
  onPreview,
  onRename,
  onDownload,
  onDelete,
}: {
  recording: Recording;
  onPreview: () => void;
  onRename: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const href = `?recording=${encodeURIComponent(recording.id)}`;
  return (
    <li className="group overflow-hidden rounded-2xl border border-line bg-surface transition-colors hover:border-line-strong">
      <a href={href} className="block" aria-label={`Open ${recording.name}`} tabIndex={-1}>
        <RecordingThumbnail recording={recording} className="aspect-video" />
      </a>
      <div className="space-y-2 p-4">
        <a href={href} className="block truncate rounded font-medium hover:text-accent-hover" title={recording.name}>
          {recording.name}
        </a>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
          <span className="inline-flex items-center gap-1" title={dateFormatter.format(recording.createdAt)}>
            <CalendarDays size={12} aria-hidden />
            <time dateTime={new Date(recording.createdAt).toISOString()}>{dateFormatter.format(recording.createdAt)}</time>
          </span>
          <span className="inline-flex items-center gap-1">
            <HardDrive size={12} aria-hidden />
            {formatBytes(recording.sizeBytes)}
          </span>
        </p>
        <div className="flex items-center gap-1 pt-1" role="group" aria-label={`Actions for ${recording.name}`}>
          <IconButton icon={Play} label={`Preview ${recording.name}`} size="sm" onClick={onPreview} />
          <IconButton icon={PencilLine} label={`Rename ${recording.name}`} size="sm" onClick={onRename} />
          <IconButton icon={Download} label={`Download ${recording.name}`} size="sm" onClick={onDownload} />
          <span className="flex-1" />
          <IconButton
            icon={Trash2}
            label={`Delete ${recording.name}`}
            size="sm"
            tone="danger"
            tooltipAlign="end"
            onClick={onDelete}
          />
        </div>
      </div>
    </li>
  );
}

export function RecordingLibrary() {
  const { recordings, loading, error, refresh } = useRecordings();
  const { settings } = useSettings();
  const toast = useToast();
  const actions = useRecordingActions({ onRenamed: () => void refresh(), onDeleted: () => void refresh() });

  const startRecording = async () => {
    if (!settings) return;
    try {
      await sendMessage('session/start', {
        options: { source: settings.defaultSource, camera: settings.cameraEnabled, microphone: settings.microphoneEnabled },
      });
    } catch (err) {
      toast.show({ variant: 'error', title: 'Could not start recording', description: getErrorMessage(err) });
    }
  };

  const newRecordingButton = (
    <Button variant="record" disabled={!settings} onClick={() => void startRecording()}>
      <span aria-hidden className="size-2 rounded-full bg-white" />
      New recording
    </Button>
  );

  const totalSize = recordings.reduce((sum, recording) => sum + recording.sizeBytes, 0);

  return (
    <div className="min-h-screen">
      <EditorHeader>{newRecordingButton}</EditorHeader>
      <main className="mx-auto max-w-6xl p-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Recordings</h1>
            <p className="mt-1 text-sm text-fg-muted">Stored only on this device, in this browser profile.</p>
          </div>
          {recordings.length > 0 && (
            <p className="text-sm text-fg-subtle">
              {recordings.length} {recordings.length === 1 ? 'recording' : 'recordings'} · {formatBytes(totalSize)}
              {recordings[0] && ` · latest ${formatRelativeTime(recordings[0].createdAt)}`}
            </p>
          )}
        </div>

        <RecoverableRecordings onRecovered={() => void refresh()} />

        {error ? (
          <div role="alert" className="space-y-3 rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
            <p>Could not load recordings. {error}</p>
            <Button size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        ) : loading ? (
          <div aria-busy="true" aria-label="Loading recordings" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="aspect-4/3 animate-pulse rounded-2xl bg-surface" />
            ))}
          </div>
        ) : recordings.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line">
            <EmptyState
              icon={Film}
              title="No recordings yet"
              description="Each recording you make is saved here, ready to preview, rename, download or edit."
              action={newRecordingButton}
            />
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Recordings">
            {recordings.map((recording) => (
              <RecordingCard
                key={recording.id}
                recording={recording}
                onPreview={() => actions.preview(recording)}
                onRename={() => actions.rename(recording)}
                onDownload={() => void actions.download(recording)}
                onDelete={() => actions.remove(recording)}
              />
            ))}
          </ul>
        )}
      </main>
      {actions.dialogs}
    </div>
  );
}
