import { useEffect, useState } from 'react';
import { ArrowLeft, FileQuestion, Loader2, Wrench } from 'lucide-react';
import { subscribeLibrary } from '@/services/storage/libraryEvents';
import { rebuildProject } from '@/services/storage/libraryRepository';
import { getRecordingDetails, MissingProjectError, type RecordingDetails } from '@/services/storage/recordingRepository';
import { Button, buttonClassName, EmptyState } from '@/shared/components';
import { describeStorageError } from '@/utils/storageErrors';
import { EditorWorkspace } from '../workspace/EditorWorkspace';
import { EditorHeader } from './EditorHeader';

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'no-project' }
  | { status: 'error'; message: string }
  | { status: 'ready'; details: RecordingDetails };

/**
 * Loads a recording and reloads it when another page renames or deletes it. Project edits are
 * owned by the open editor (it saves them itself), so project changes don't trigger a reload.
 */
function useRecordingDetails(recordingId: string): [LoadState, () => void] {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const load = () =>
      getRecordingDetails(recordingId).then(
        (details) => active && setState(details ? { status: 'ready', details } : { status: 'missing' }),
        (error: unknown) => active && setState(error instanceof MissingProjectError ? { status: 'no-project' } : { status: 'error', message: describeStorageError(error) }),
      );
    void load();
    const unsubscribe = subscribeLibrary((change) => {
      if (change.type !== 'project' && 'recordingId' in change && change.recordingId === recordingId) void load();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [recordingId, attempt]);
  return [state, () => setAttempt((n) => n + 1)];
}

const backLink = (
  <a href="index.html" className={buttonClassName({ variant: 'ghost', size: 'sm' })}>
    <ArrowLeft size={14} aria-hidden />
    All recordings
  </a>
);

export function RecordingWorkspace({ recordingId }: { recordingId: string }) {
  const [state, reload] = useRecordingDetails(recordingId);
  const [rebuilding, setRebuilding] = useState<string | null>(null);

  if (state.status !== 'ready') {
    return (
      <div className="min-h-screen">
        <EditorHeader />
        <main className="flex min-h-[70vh] items-center justify-center p-6">
          {state.status === 'loading' ? (
            <Loader2 size={28} aria-label="Loading recording" className="animate-spin text-fg-subtle" />
          ) : state.status === 'no-project' ? (
            <EmptyState
              icon={Wrench}
              title="This recording’s project is missing"
              description={
                rebuilding ??
                'The recording and its media are safe, but its edits couldn’t be found (for example after an interrupted operation). Rebuild the project to edit it again: the timeline is made from the recording, as when it was saved.'
              }
              action={
                <div className="flex gap-2">
                  {backLink}
                  <Button
                    variant="primary"
                    icon={Wrench}
                    onClick={() =>
                      void rebuildProject(recordingId).then(reload, (error: unknown) => setRebuilding(`Could not rebuild it: ${describeStorageError(error)}`))
                    }
                  >
                    Rebuild project
                  </Button>
                </div>
              }
            />
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

  // Keyed by project: a different project gets a fresh editor (and undo history).
  return <EditorWorkspace key={state.details.project.id} details={state.details} />;
}
