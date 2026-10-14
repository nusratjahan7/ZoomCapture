import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  CalendarDays,
  Copy,
  Download,
  Film,
  HardDrive,
  History,
  Loader2,
  PencilLine,
  Play,
  Scissors,
  Search,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { sendMessage } from '@/services/messaging';
import { notifyLibraryChanged } from '@/services/storage/libraryEvents';
import { duplicateProject, filterLibrary, rebuildProject, type LibraryEntry, type LibrarySort } from '@/services/storage/libraryRepository';
import { availableSpace } from '@/services/storage/storageStatus';
import { Button, EmptyState, IconButton, RecordingThumbnail, useToast } from '@/shared/components';
import { useLibrary } from '@/shared/hooks/useLibrary';
import { useRecordingActions } from '@/shared/hooks/useRecordingActions';
import { useSettings } from '@/shared/hooks/useSettings';
import { useStorageStatus } from '@/shared/hooks/useStorageStatus';
import { getErrorMessage } from '@/utils/errors';
import { formatBytes, formatDuration, formatRelativeTime } from '@/utils/format';
import { describeStorageError } from '@/utils/storageErrors';
import { EditorHeader } from './EditorHeader';
import { RecoverableRecordings } from './RecoverableRecordings';

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Projects above these take noticeably more memory and time to edit and export. */
export const LARGE_PROJECT = { bytes: 2 * 1024 ** 3, durationMs: 30 * 60_000 };
export const isLargeProject = (entry: LibraryEntry) => entry.totalBytes >= LARGE_PROJECT.bytes || entry.recording.durationMs >= LARGE_PROJECT.durationMs;

const SORTS: Array<{ value: LibrarySort; label: string }> = [
  { value: 'modified', label: 'Last modified' },
  { value: 'created', label: 'Date recorded' },
  { value: 'name', label: 'Name' },
  { value: 'duration', label: 'Duration' },
  { value: 'size', label: 'Size' },
];

const VIEW_KEY = 'zoomcapture.library.view';

/** Search and sort, remembered in this browser (a convenience: falls back to defaults). */
function useLibraryView() {
  const [view, setView] = useState<{ query: string; sort: LibrarySort; descending: boolean }>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null') as { sort?: LibrarySort; descending?: boolean } | null;
      if (stored && SORTS.some((option) => option.value === stored.sort)) return { query: '', sort: stored.sort!, descending: stored.descending !== false };
    } catch {
      // Storage unavailable or corrupt: defaults.
    }
    return { query: '', sort: 'modified', descending: true };
  });
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ sort: view.sort, descending: view.descending }));
    } catch {
      // Not remembered; nothing else depends on it.
    }
  }, [view.sort, view.descending]);
  return [view, setView] as const;
}

function ProjectCard({
  entry,
  busy,
  onPreview,
  onRename,
  onDuplicate,
  onDownload,
  onDelete,
  onRebuild,
}: {
  entry: LibraryEntry;
  busy: boolean;
  onPreview: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onRebuild: () => void;
}) {
  const { recording, project } = entry;
  const href = `?recording=${encodeURIComponent(recording.id)}`;
  const large = isLargeProject(entry);
  return (
    <li className="group overflow-hidden rounded-2xl border border-line bg-surface transition-colors hover:border-line-strong" data-recording={recording.id}>
      <a href={href} className="block" aria-label={`Open ${recording.name}`} tabIndex={-1}>
        <RecordingThumbnail recording={recording} className="aspect-video" />
      </a>
      <div className="space-y-2 p-4">
        <a href={href} className="block truncate rounded font-medium hover:text-accent-hover" title={recording.name}>
          {recording.name}
        </a>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
          <span className="inline-flex items-center gap-1" title={`Recorded ${dateFormatter.format(recording.createdAt)}`}>
            <CalendarDays size={12} aria-hidden />
            <time dateTime={new Date(recording.createdAt).toISOString()}>{dateFormatter.format(recording.createdAt)}</time>
          </span>
          <span className="inline-flex items-center gap-1" title="The recording and the files imported into its project">
            <HardDrive size={12} aria-hidden />
            {formatBytes(entry.totalBytes)}
          </span>
        </p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
          <span className="inline-flex items-center gap-1" title={`Last modified ${dateFormatter.format(entry.modifiedAt)}`} data-testid="modified">
            <History size={12} aria-hidden />
            {project?.edited ? `Edited ${formatRelativeTime(entry.modifiedAt)}` : project ? 'Not edited yet' : 'Project missing'}
          </span>
          {project && project.importedCount > 0 && (
            <span>
              {project.importedCount} imported {project.importedCount === 1 ? 'file' : 'files'}
            </span>
          )}
        </p>
        {large && (
          <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-2 py-1.5 text-[11px] text-warning" data-testid="large-project">
            <AlertTriangle size={12} aria-hidden className="mt-px shrink-0" />
            Large project: editing and exporting need more memory and time. Save exports to a file.
          </p>
        )}
        {!project && (
          <div className="space-y-1.5 rounded-lg bg-warning/10 p-2 text-xs text-warning" role="status">
            <p>The edits of this recording couldn’t be found. The recording itself is safe.</p>
            <Button size="sm" icon={Wrench} loading={busy} onClick={onRebuild}>
              Rebuild project
            </Button>
          </div>
        )}
        <div className="flex items-center gap-1 pt-1" role="group" aria-label={`Actions for ${recording.name}`}>
          <a
            href={href}
            aria-label={`Edit ${recording.name}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent/15 px-2.5 text-xs font-medium text-accent-hover transition-colors hover:bg-accent/25"
          >
            <Scissors size={13} aria-hidden /> Edit
          </a>
          <IconButton icon={Play} label={`Preview ${recording.name}`} size="sm" onClick={onPreview} />
          <IconButton icon={PencilLine} label={`Rename ${recording.name}`} size="sm" onClick={onRename} />
          <IconButton icon={busy ? Loader2 : Copy} label={`Duplicate ${recording.name}`} size="sm" disabled={busy || !project} onClick={onDuplicate} />
          <IconButton icon={Download} label={`Download ${recording.name}`} size="sm" onClick={onDownload} />
          <span className="flex-1" />
          <IconButton icon={Trash2} label={`Delete ${recording.name}`} size="sm" tone="danger" tooltipAlign="end" onClick={onDelete} />
        </div>
      </div>
    </li>
  );
}

/**
 * The project dashboard: every recording with its editable project, searchable and sortable, with
 * thumbnails, sizes and dates; preview, edit, rename, duplicate, download and delete; recovery of
 * unfinished recordings and of missing projects; storage use and low-space warnings.
 */
export function RecordingLibrary() {
  const { entries, loading, error, refresh } = useLibrary();
  const { settings } = useSettings();
  const storage = useStorageStatus();
  const toast = useToast();
  const actions = useRecordingActions({ onRenamed: () => void refresh(), onDeleted: () => void refresh() });
  const [view, setView] = useLibraryView();
  const [busy, setBusy] = useState<string | null>(null);
  const shown = useMemo(() => filterLibrary(entries, view.query, view.sort, view.descending), [entries, view]);

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

  const duplicate = async (entry: LibraryEntry) => {
    setBusy(entry.recording.id);
    try {
      // The copy needs as much space as the original: refuse up front rather than fail half-way.
      const free = await availableSpace();
      if (free !== undefined && free < entry.totalBytes * 1.1 + 50 * 1024 ** 2) {
        throw new Error(`Duplicating needs about ${formatBytes(entry.totalBytes)} of free space; ${formatBytes(free)} is left. Free some space first.`);
      }
      const copy = await duplicateProject(entry.recording.id);
      notifyLibraryChanged({ type: 'saved', recordingId: copy.id });
      toast.show({ variant: 'success', title: 'Project duplicated', description: copy.name });
      await refresh();
    } catch (err) {
      toast.show({ variant: 'error', title: 'Could not duplicate the project', description: describeStorageError(err) });
    } finally {
      setBusy(null);
    }
  };

  const rebuild = async (entry: LibraryEntry) => {
    setBusy(entry.recording.id);
    try {
      await rebuildProject(entry.recording.id);
      notifyLibraryChanged({ type: 'saved', recordingId: entry.recording.id });
      toast.show({ variant: 'success', title: 'Project rebuilt', description: 'Its timeline was made again from the recording. Earlier edits couldn’t be recovered.' });
      await refresh();
    } catch (err) {
      toast.show({ variant: 'error', title: 'Could not rebuild the project', description: describeStorageError(err) });
    } finally {
      setBusy(null);
    }
  };

  const newRecordingButton = (
    <Button variant="record" disabled={!settings} onClick={() => void startRecording()}>
      <span aria-hidden className="size-2 rounded-full bg-white" />
      New recording
    </Button>
  );

  const totalSize = entries.reduce((sum, entry) => sum + entry.totalBytes, 0);
  const latest = entries.reduce((max, entry) => Math.max(max, entry.recording.createdAt), 0);

  return (
    <div className="min-h-screen">
      <EditorHeader>{newRecordingButton}</EditorHeader>
      <main className="mx-auto max-w-6xl p-6">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Recordings</h1>
            <p className="mt-1 text-sm text-fg-muted">Recordings and their edited projects, stored only on this device, in this browser profile.</p>
          </div>
          {entries.length > 0 && (
            <p className="text-sm text-fg-subtle" data-testid="library-totals">
              {entries.length} {entries.length === 1 ? 'recording' : 'recordings'} · {formatBytes(totalSize)}
              {latest > 0 && ` · latest ${formatRelativeTime(latest)}`}
            </p>
          )}
        </div>

        {storage.low && (
          <p role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm text-warning" data-testid="low-storage">
            <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0" />
            <span>
              Storage is almost full: about {formatBytes(storage.free ?? 0)} left for this browser. New recordings and imports may fail. Free space on the disk, or download and delete
              recordings you no longer need.
            </span>
          </p>
        )}

        <RecoverableRecordings onRecovered={() => void refresh()} />

        {entries.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <label className="relative min-w-48 flex-1">
              <span className="sr-only">Search recordings</span>
              <Search size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-subtle" />
              <input
                type="search"
                value={view.query}
                placeholder="Search by name"
                onChange={(event) => setView((current) => ({ ...current, query: event.target.value }))}
                className="h-9 w-full rounded-xl border border-line-strong bg-surface-2 pr-3 pl-8 text-sm"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              Sort by
              <select
                value={view.sort}
                onChange={(event) => setView((current) => ({ ...current, sort: event.target.value as LibrarySort, descending: event.target.value !== 'name' }))}
                className="h-9 rounded-xl border border-line-strong bg-surface-2 px-2 text-sm text-fg"
              >
                {SORTS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <IconButton
              icon={view.descending ? ArrowDownWideNarrow : ArrowUpNarrowWide}
              label={view.descending ? 'Descending order (click for ascending)' : 'Ascending order (click for descending)'}
              size="sm"
              onClick={() => setView((current) => ({ ...current, descending: !current.descending }))}
            />
          </div>
        )}

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
        ) : entries.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line">
            <EmptyState
              icon={Film}
              title="No recordings yet"
              description="Each recording you make is saved here, ready to preview, rename, edit, duplicate or download."
              action={newRecordingButton}
            />
          </div>
        ) : shown.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line">
            <EmptyState
              icon={Search}
              title={`No recordings match “${view.query.trim()}”`}
              description="Search looks at recording names."
              action={
                <Button size="sm" icon={X} onClick={() => setView((current) => ({ ...current, query: '' }))}>
                  Clear search
                </Button>
              }
            />
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Recordings">
            {shown.map((entry) => (
              <ProjectCard
                key={entry.recording.id}
                entry={entry}
                busy={busy === entry.recording.id}
                onPreview={() => actions.preview(entry.recording)}
                onRename={() => actions.rename(entry.recording)}
                onDuplicate={() => void duplicate(entry)}
                onDownload={() => void actions.download(entry.recording)}
                onDelete={() => actions.remove(entry.recording)}
                onRebuild={() => void rebuild(entry)}
              />
            ))}
          </ul>
        )}
        {entries.length > 0 && <p className="mt-6 text-xs text-fg-subtle">Total length {formatDuration(entries.reduce((sum, entry) => sum + entry.recording.durationMs, 0))}.</p>}
      </main>
      {actions.dialogs}
    </div>
  );
}
