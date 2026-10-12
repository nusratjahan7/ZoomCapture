import { useEffect, useState } from 'react';
import { ChevronRight, Film, FolderOpen, LifeBuoy } from 'lucide-react';
import { sendMessage } from '@/services/messaging';
import { subscribeLibrary } from '@/services/storage/libraryEvents';
import { listDrafts } from '@/services/storage/recordingDraftRepository';
import { Button, EmptyState, RecordingThumbnail, useToast } from '@/shared/components';
import { useRecordings } from '@/shared/hooks/useRecordings';
import type { ExtensionPage, RecordingSession } from '@/types';
import { getErrorMessage } from '@/utils/errors';
import { formatBytes, formatDuration, formatRelativeTime } from '@/utils/format';

const RECENT_LIMIT = 3;

/** Drafts that are not the session currently in progress, i.e. interrupted recordings. */
function useUnfinishedCount(activeSessionId: string | undefined): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const load = () =>
      void listDrafts().then(
        (drafts) => setCount(drafts.filter((draft) => draft.id !== activeSessionId).length),
        () => setCount(0),
      );
    load();
    return subscribeLibrary(load);
  }, [activeSessionId]);
  return count;
}

export function RecentRecordings({ session }: { session: RecordingSession | null }) {
  const { recordings, loading, error } = useRecordings(RECENT_LIMIT);
  const unfinished = useUnfinishedCount(session?.id);
  const toast = useToast();

  const open = async (page: ExtensionPage, params?: Record<string, string>) => {
    try {
      await sendMessage('page/open', { page, params });
      window.close();
    } catch (err) {
      toast.show({ variant: 'error', title: 'Could not open the editor', description: getErrorMessage(err) });
    }
  };

  return (
    <section aria-labelledby="recent-heading">
      <div className="mb-2 flex items-center justify-between">
        <h2 id="recent-heading" className="text-xs font-semibold tracking-wider text-fg-subtle uppercase">
          Recent recordings
        </h2>
        <Button variant="ghost" size="sm" icon={FolderOpen} onClick={() => void open('editor')}>
          Library
        </Button>
      </div>

      {unfinished > 0 && (
        <button
          type="button"
          onClick={() => void open('editor')}
          className="mb-2 flex w-full items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 p-2.5 text-left text-xs text-warning transition-colors hover:bg-warning/15"
        >
          <LifeBuoy size={14} aria-hidden className="shrink-0" />
          <span className="flex-1">
            {unfinished === 1 ? '1 unfinished recording' : `${unfinished} unfinished recordings`} can be recovered
          </span>
          <ChevronRight size={14} aria-hidden />
        </button>
      )}

      {error ? (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          Could not load recordings. {error}
        </p>
      ) : loading ? (
        <div aria-busy="true" aria-label="Loading recordings" className="space-y-2">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-surface-2" />
          ))}
        </div>
      ) : recordings.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line">
          <EmptyState compact icon={Film} title="No recordings yet" description="Your recordings will appear here." />
        </div>
      ) : (
        <ul className="space-y-1.5">
          {recordings.map((recording) => (
            <li key={recording.id}>
              <button
                type="button"
                onClick={() => void open('editor', { recording: recording.id })}
                className="group flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-2 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
              >
                <RecordingThumbnail recording={recording} showDuration={false} className="h-10 w-18 shrink-0 rounded-lg" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{recording.name}</span>
                  <span className="block text-xs text-fg-subtle">
                    {formatRelativeTime(recording.createdAt)} · {formatDuration(recording.durationMs)} ·{' '}
                    {formatBytes(recording.sizeBytes)}
                  </span>
                </span>
                <ChevronRight size={16} aria-hidden className="text-fg-subtle transition-transform group-hover:translate-x-0.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
