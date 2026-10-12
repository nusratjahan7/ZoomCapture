import { useEffect, useState, type FormEvent } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { RECORDING_NAME_MAX_LENGTH } from '@/services/storage/recordingRepository';
import type { Recording } from '@/types';
import { getErrorMessage } from '@/utils/errors';
import { formatBytes, formatDuration } from '@/utils/format';
import { useAssetUrl } from '../hooks/useAssetUrl';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { TextField } from './TextField';

export function RenameDialog({
  recording,
  onClose,
  onRename,
}: {
  recording: Recording | null;
  onClose: () => void;
  onRename: (recording: Recording, name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (recording) {
      setName(recording.name);
      setError(null);
    }
  }, [recording]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!recording) return;
    setSaving(true);
    try {
      await onRename(recording, name);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={recording !== null} onClose={saving ? () => undefined : onClose} title="Rename recording">
      <form onSubmit={(event) => void submit(event)}>
        <TextField
          label="Name"
          value={name}
          maxLength={RECORDING_NAME_MAX_LENGTH}
          error={error}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onValueChange={(value) => {
            setName(value);
            setError(null);
          }}
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            Save name
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Plays a recording in a dialog. The video's object URL is revoked when the dialog closes. */
export function PreviewDialog({
  recording,
  onClose,
  onDownload,
}: {
  recording: Recording | null;
  onClose: () => void;
  onDownload: (recording: Recording) => void;
}) {
  const { url, error } = useAssetUrl(recording?.screenAssetId);

  return (
    <Dialog
      open={recording !== null}
      onClose={onClose}
      size="lg"
      title={recording?.name ?? 'Preview'}
      description={
        recording
          ? `${formatDuration(recording.durationMs)} · ${formatBytes(recording.sizeBytes)} · recorded ${new Date(recording.createdAt).toLocaleString()}`
          : undefined
      }
      footer={
        recording && (
          <Button icon={Download} onClick={() => onDownload(recording)}>
            Download
          </Button>
        )
      }
    >
      <div className="flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-line bg-black">
        {url ? (
          <video src={url} controls autoPlay className="h-full w-full" aria-label={`Preview of ${recording?.name ?? 'recording'}`} />
        ) : error ? (
          <p role="alert" className="text-sm text-danger">
            The video file is missing from local storage.
          </p>
        ) : (
          <Loader2 size={24} aria-label="Loading video" className="animate-spin text-fg-subtle" />
        )}
      </div>
    </Dialog>
  );
}
