import { useState } from 'react';
import { Clock, Film, Trash2 } from 'lucide-react';
import { sendMessage } from '@/services/messaging';
import { deleteProject } from '@/services/storage/projectRepository';
import { Button, ConfirmDialog, EmptyState, IconButton, useToast } from '@/shared/components';
import { useProjects } from '@/shared/hooks/useProjects';
import { useSettings } from '@/shared/hooks/useSettings';
import type { ProjectSummary } from '@/types';
import { getErrorMessage } from '@/utils/errors';
import { formatDuration, formatRelativeTime } from '@/utils/format';
import { EditorHeader } from './EditorHeader';

export function ProjectLibrary() {
  const { projects, loading, error, refresh } = useProjects();
  const { settings } = useSettings();
  const toast = useToast();
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);

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

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteProject(pendingDelete.id);
      toast.show({ variant: 'success', title: `Deleted “${pendingDelete.name}”` });
      await refresh();
    } catch (err) {
      toast.show({ variant: 'error', title: 'Could not delete the project', description: getErrorMessage(err) });
    }
  };

  const newRecordingButton = (
    <Button variant="record" disabled={!settings} onClick={() => void startRecording()}>
      <span aria-hidden className="size-2 rounded-full bg-white" />
      New recording
    </Button>
  );

  return (
    <div className="min-h-screen">
      <EditorHeader>{newRecordingButton}</EditorHeader>
      <main className="mx-auto max-w-6xl p-6">
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-fg-muted">Recordings are stored locally in this browser profile.</p>
        </div>

        {error ? (
          <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
            Could not load projects: {error}
          </p>
        ) : loading ? (
          <div aria-busy="true" aria-label="Loading projects" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="aspect-[4/3] animate-pulse rounded-2xl bg-surface" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line">
            <EmptyState
              icon={Film}
              title="No projects yet"
              description="Each recording becomes a project you can edit here, with zoom effects and a timeline."
              action={newRecordingButton}
            />
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <li
                key={project.id}
                className="group relative overflow-hidden rounded-2xl border border-line bg-surface transition-colors hover:border-line-strong"
              >
                <a href={`?project=${encodeURIComponent(project.id)}`} className="block rounded-2xl">
                  <div className="flex aspect-video items-center justify-center bg-surface-2 text-fg-subtle">
                    <Film size={28} aria-hidden />
                  </div>
                  <div className="p-4 pr-14">
                    <p className="truncate font-medium">{project.name}</p>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-fg-subtle">
                      <Clock size={12} aria-hidden />
                      {formatDuration(project.durationMs)} · edited {formatRelativeTime(project.updatedAt)}
                    </p>
                  </div>
                </a>
                <div className="absolute right-3 bottom-3.5">
                  <IconButton
                    icon={Trash2}
                    label={`Delete ${project.name}`}
                    tone="danger"
                    size="sm"
                    tooltipAlign="end"
                    onClick={() => setPendingDelete(project)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title="Delete this project?"
        description={`“${pendingDelete?.name ?? ''}” and all of its media will be permanently removed from this browser.`}
        confirmLabel="Delete project"
        tone="danger"
      />
    </div>
  );
}
