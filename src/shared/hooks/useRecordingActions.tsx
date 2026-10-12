import { useCallback, useState, type ReactNode } from 'react';
import { downloadBlob } from '@/services/export/download';
import { exportRecording } from '@/services/export/exporters';
import { notifyLibraryChanged } from '@/services/storage/libraryEvents';
import { deleteRecording, getRecordingDetails, renameRecording } from '@/services/storage/recordingRepository';
import type { Recording } from '@/types';
import { describeStorageError } from '@/utils/storageErrors';
import { ConfirmDialog } from '../components/Dialog';
import { PreviewDialog, RenameDialog } from '../components/RecordingDialogs';
import { useToast } from '../components/Toast';

export interface RecordingActions {
  rename: (recording: Recording) => void;
  preview: (recording: Recording) => void;
  remove: (recording: Recording) => void;
  download: (recording: Recording) => Promise<void>;
  /** Render once in the page: the rename, preview and delete dialogs. */
  dialogs: ReactNode;
}

/**
 * Rename / preview / download / delete for stored recordings, with confirmation, success
 * notifications and recoverable error messages. Shared by the library, editor and studio.
 */
export function useRecordingActions(callbacks: {
  onRenamed?: (recording: Recording) => void;
  onDeleted?: (recording: Recording) => void;
} = {}): RecordingActions {
  const toast = useToast();
  const [renaming, setRenaming] = useState<Recording | null>(null);
  const [previewing, setPreviewing] = useState<Recording | null>(null);
  const [deleting, setDeleting] = useState<Recording | null>(null);

  const download = useCallback(
    async (recording: Recording) => {
      try {
        const details = await getRecordingDetails(recording.id);
        if (!details) throw new Error('This recording no longer exists.');
        const { blob, fileName } = await exportRecording(details, 'webm');
        downloadBlob(blob, fileName);
        toast.show({ variant: 'success', title: 'Download started', description: fileName });
      } catch (error) {
        toast.show({ variant: 'error', title: 'Download failed', description: describeStorageError(error) });
      }
    },
    [toast],
  );

  const onRename = async (recording: Recording, name: string) => {
    // Validation errors surface inside the dialog; storage errors too, so the user can retry.
    const updated = await renameRecording(recording.id, name);
    notifyLibraryChanged({ type: 'renamed', recordingId: updated.id });
    toast.show({ variant: 'success', title: 'Recording renamed', description: updated.name });
    callbacks.onRenamed?.(updated);
  };

  const onDelete = async () => {
    if (!deleting) return;
    try {
      await deleteRecording(deleting.id);
      notifyLibraryChanged({ type: 'deleted', recordingId: deleting.id });
      toast.show({ variant: 'success', title: 'Recording deleted', description: deleting.name });
      callbacks.onDeleted?.(deleting);
    } catch (error) {
      toast.show({ variant: 'error', title: 'Could not delete the recording', description: describeStorageError(error) });
    }
  };

  const dialogs = (
    <>
      <RenameDialog recording={renaming} onClose={() => setRenaming(null)} onRename={onRename} />
      <PreviewDialog recording={previewing} onClose={() => setPreviewing(null)} onDownload={(rec) => void download(rec)} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={onDelete}
        title="Delete this recording?"
        description={`“${deleting?.name ?? ''}” and all of its media and edits will be permanently removed from this browser. This cannot be undone.`}
        confirmLabel="Delete recording"
        tone="danger"
      />
    </>
  );

  return { rename: setRenaming, preview: setPreviewing, remove: setDeleting, download, dialogs };
}
