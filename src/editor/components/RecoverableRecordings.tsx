import { useCallback, useEffect, useState } from 'react';
import { LifeBuoy, Trash2 } from 'lucide-react';
import { ensureThumbnail } from '@/services/media/thumbnail';
import { finalizeDraft } from '@/services/recording/finalizeRecording';
import { notifyLibraryChanged, subscribeLibrary } from '@/services/storage/libraryEvents';
import { deleteDraft, listDrafts } from '@/services/storage/recordingDraftRepository';
import { Button, ConfirmDialog, Panel, ProgressBar, useToast } from '@/shared/components';
import { useActiveSession } from '@/shared/hooks/useActiveSession';
import type { RecordingDraft } from '@/types';
import { describeStorageError } from '@/utils/storageErrors';
import { formatBytes, formatDuration, formatRelativeTime } from '@/utils/format';

/**
 * Recordings that were interrupted before being saved (browser crash, failed save, full disk).
 * Their media was written to IndexedDB second by second and is kept until the user recovers or
 * discards it; it is never deleted automatically.
 */
export function RecoverableRecordings({ onRecovered }: { onRecovered: () => void }) {
  const toast = useToast();
  const { session, loaded } = useActiveSession();
  const [drafts, setDrafts] = useState<RecordingDraft[]>([]);
  const [busy, setBusy] = useState<{ id: string; fraction: number } | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<RecordingDraft | null>(null);

  const refresh = useCallback(async () => setDrafts(await listDrafts()), []);
  useEffect(() => {
    void refresh();
    return subscribeLibrary(() => void refresh());
  }, [refresh]);

  // The draft of the session being recorded right now is not "unfinished".
  const visible = loaded ? drafts.filter((draft) => draft.id !== session?.id) : [];
  if (visible.length === 0) return null;

  const recover = async (draft: RecordingDraft) => {
    setBusy({ id: draft.id, fraction: 0 });
    try {
      const { recording } = await finalizeDraft(draft.id, {
        onProgress: ({ fraction }) => setBusy({ id: draft.id, fraction }),
      });
      await ensureThumbnail(recording.id).catch(() => null);
      notifyLibraryChanged({ type: 'saved', recordingId: recording.id });
      toast.show({ variant: 'success', title: 'Recording recovered', description: recording.name });
      onRecovered();
    } catch (error) {
      toast.show({ variant: 'error', title: 'Recovery failed', description: describeStorageError(error), duration: 12_000 });
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  return (
    <Panel
      className="mb-6 border-warning/40"
      title="Unfinished recordings"
      description="These recordings were interrupted before they were saved. Everything captured up to the interruption can be recovered."
    >
      <ul className="space-y-2">
        {visible.map((draft) => (
          <li key={draft.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-surface-2 p-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{draft.name}</p>
              <p className="text-xs text-fg-subtle">
                {formatDuration(draft.durationMs)} · {draft.tracks.length} tracks ·{' '}
                {formatBytes(draft.tracks.reduce((sum, track) => sum + track.bytes, 0))} · interrupted{' '}
                {formatRelativeTime(draft.updatedAt)}
              </p>
            </div>
            <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setPendingDiscard(draft)} disabled={busy !== null}>
              Discard
            </Button>
            <Button size="sm" variant="primary" icon={LifeBuoy} loading={busy?.id === draft.id} onClick={() => void recover(draft)}>
              Recover
            </Button>
            {busy?.id === draft.id && <ProgressBar value={busy.fraction} label={`Recovering ${draft.name}`} className="basis-full" />}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={pendingDiscard !== null}
        onClose={() => setPendingDiscard(null)}
        onConfirm={async () => {
          if (pendingDiscard) await deleteDraft(pendingDiscard.id);
          notifyLibraryChanged({ type: 'drafts' });
          await refresh();
        }}
        title="Discard this recording?"
        description="The captured media will be permanently deleted from this browser."
        confirmLabel="Discard recording"
        tone="danger"
      />
    </Panel>
  );
}
