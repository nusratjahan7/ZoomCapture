import { useEffect, useState } from 'react';
import { ArrowLeft, FileQuestion, Loader2 } from 'lucide-react';
import { subscribeLibrary } from '@/services/storage/libraryEvents';
import { getRecordingDetails, type RecordingDetails } from '@/services/storage/recordingRepository';
import { buttonClassName, EmptyState } from '@/shared/components';
import { describeStorageError } from '@/utils/storageErrors';
import { EditorWorkspace } from '../workspace/EditorWorkspace';
import { EditorHeader } from './EditorHeader';

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; details: RecordingDetails };

/**
 * Loads a recording and reloads it when another page renames or deletes it. Project edits are
 * owned by the open editor (it saves them itself), so project changes don't trigger a reload.
 */
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
      if (change.type !== 'project' && 'recordingId' in change && change.recordingId === recordingId) void load();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [recordingId]);
  return state;
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

  // Keyed by project: a different project gets a fresh editor (and undo history).
  return <EditorWorkspace key={state.details.project.id} details={state.details} />;
}
