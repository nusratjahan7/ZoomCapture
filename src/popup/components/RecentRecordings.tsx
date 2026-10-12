import { ChevronRight, Film, FolderOpen } from 'lucide-react';
import { sendMessage } from '@/services/messaging';
import { Button, EmptyState, useToast } from '@/shared/components';
import { useProjects } from '@/shared/hooks/useProjects';
import type { ExtensionPage } from '@/types';
import { getErrorMessage } from '@/utils/errors';
import { formatDuration, formatRelativeTime } from '@/utils/format';

const RECENT_LIMIT = 3;

export function RecentRecordings() {
  const { projects, loading, error } = useProjects(RECENT_LIMIT);
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

      {error ? (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          Could not load recordings: {error}
        </p>
      ) : loading ? (
        <div aria-busy="true" aria-label="Loading recordings" className="space-y-2">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-surface-2" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line">
          <EmptyState compact icon={Film} title="No recordings yet" description="Your recordings will appear here." />
        </div>
      ) : (
        <ul className="space-y-1.5">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                onClick={() => void open('editor', { project: project.id })}
                className="group flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-2.5 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-fg-muted">
                  <Film size={16} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{project.name}</span>
                  <span className="block text-xs text-fg-subtle">
                    {formatRelativeTime(project.updatedAt)} · {formatDuration(project.durationMs)}
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
