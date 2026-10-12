import { HardDriveDownload } from 'lucide-react';
import { ProgressBar } from '@/shared/components';
import type { SaveProgress } from '@/types';

const STAGE_LABELS: Record<SaveProgress['stage'], string> = {
  preparing: 'Finishing the recording…',
  processing: 'Writing media files…',
  saving: 'Saving to your library…',
  thumbnail: 'Creating a thumbnail…',
  done: 'Saved',
};

/** Shown while a recording is written to local storage. */
export function SavingProgress({ progress }: { progress: SaveProgress | null }) {
  const stage = progress?.stage ?? 'preparing';
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface p-6 text-center" role="status">
        <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-hover">
          <HardDriveDownload size={22} aria-hidden />
        </span>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Saving your recording</h1>
          <p className="mt-1 text-sm text-fg-muted">{STAGE_LABELS[stage]}</p>
        </div>
        <ProgressBar value={progress?.fraction ?? 0} label="Saving progress" />
        <p className="text-xs text-fg-subtle">Keep this tab open. If it closes, the recording can still be recovered.</p>
      </div>
    </main>
  );
}
