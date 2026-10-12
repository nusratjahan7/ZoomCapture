import { useCallback, useEffect, useState } from 'react';
import { LifeBuoy, Trash2 } from 'lucide-react';
import { finalizeDraft } from '@/services/recording/finalizeRecording';
import { deleteDraft, listDrafts } from '@/services/storage/recordingDraftRepository';
import { Button, ConfirmDialog, Panel, useToast } from '@/shared/components';
import { useActiveSession } from '@/shared/hooks/useActiveSession';
import type { RecordingDraft } from '@/types';
import { getErrorMessage } from '@/utils/errors';
import { formatBytes, formatDuration, formatRelativeTime } from '@/utils/format';

/**
 * Recordings whose studio stopped unexpectedly (browser crash, tab killed). Their media was
 * saved to IndexedDB second by second and can be turned into a project here.
 */
export function RecoverableRecordings({ onRecovered }: { onRecovered: () => void }) {
  const toast = useToast();
  const { session, loaded } = useActiveSession();
  const [drafts, setDrafts] = useState<RecordingDraft[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<RecordingDraft | null>(null);

  const refresh = useCallback(async () => setDrafts(await listDrafts()), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The draft of the session being recorded right now is not "unfinished".
  const visible = loaded ? drafts.filter((draft) => draft.id !== session?.id) : [];
  if (visible.length === 0) return null;

  const recover = async (draft: RecordingDraft) => {
    setBusyId(draft.id);
    try {
      const project = await finalizeDraft(draft.id);
      toast.show(
        project
          ? { variant: 'success', title: 'Recording recovered', description: project.name }
          : { variant: 'error', title: 'Nothing could be recovered', description: 'No screen video was captured.' },
      );
      onRecovered();
    } catch (error) {
      toast.show({ variant: 'error', title: 'Recovery failed', description: getErrorMessage(error) });
    } finally {
      setBusyId(null);
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
            <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setPendingDiscard(draft)} disabled={busyId !== null}>
              Discard
            </Button>
            <Button size="sm" variant="primary" icon={LifeBuoy} loading={busyId === draft.id} onClick={() => void recover(draft)}>
              Recover
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={pendingDiscard !== null}
        onClose={() => setPendingDiscard(null)}
        onConfirm={async () => {
          if (pendingDiscard) await deleteDraft(pendingDiscard.id);
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
