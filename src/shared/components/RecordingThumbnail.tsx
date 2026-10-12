import { useEffect } from 'react';
import { Film } from 'lucide-react';
import { ensureThumbnail } from '@/services/media/thumbnail';
import { notifyLibraryChanged } from '@/services/storage/libraryEvents';
import type { Recording } from '@/types';
import { cn } from '@/utils/cn';
import { formatDuration } from '@/utils/format';
import { useAssetUrl } from '../hooks/useAssetUrl';

/**
 * Poster image of a recording. Recordings saved without a thumbnail (e.g. rescued by the service
 * worker) get one generated on first display.
 */
export function RecordingThumbnail({
  recording,
  showDuration = true,
  className,
}: {
  recording: Recording;
  showDuration?: boolean;
  className?: string;
}) {
  const { url } = useAssetUrl(recording.thumbnailAssetId);

  useEffect(() => {
    if (recording.thumbnailAssetId) return;
    void ensureThumbnail(recording.id).then(
      (assetId) => assetId && notifyLibraryChanged({ type: 'thumbnail', recordingId: recording.id }),
    );
  }, [recording.id, recording.thumbnailAssetId]);

  return (
    <div className={cn('relative overflow-hidden bg-surface-2', className)}>
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-fg-subtle">
          <Film size={22} aria-hidden />
        </div>
      )}
      {showDuration && (
        <span className="absolute right-1.5 bottom-1.5 rounded-md bg-black/75 px-1.5 py-0.5 font-mono text-[11px] font-medium text-white tabular-nums">
          {formatDuration(recording.durationMs)}
        </span>
      )}
    </div>
  );
}
