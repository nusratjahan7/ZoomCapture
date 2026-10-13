import { Mic, MicOff, Pause, Play, Square, Video, VideoOff } from 'lucide-react';
import { IconButton } from '@/shared/components';
import { cn } from '@/utils/cn';
import { formatClock } from '@/utils/format';
import type { FlowPhase } from '../hooks/useRecordingFlow';
import { StreamVideo } from './StreamVideo';

export interface FloatingControlsProps {
  phase: FlowPhase;
  countdown: number;
  elapsedMs: number;
  camera: MediaStream | null;
  cameraHidden: boolean;
  micAvailable: boolean;
  micMuted: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onToggleMic: () => void;
  onToggleCamera: () => void;
}

/** Requested window sizes (Chrome may enforce a slightly larger minimum). */
export const FLOATING_SIZE = {
  withCamera: { width: 176, height: 216 },
  controlsOnly: { width: 216, height: 44 },
};

/**
 * Content of the floating Picture-in-Picture window: the camera bubble plus recording controls.
 * The window stays on top of other apps and can be moved anywhere by the user.
 */
export function FloatingControls({
  phase,
  countdown,
  elapsedMs,
  camera,
  cameraHidden,
  micAvailable,
  micMuted,
  onPause,
  onResume,
  onStop,
  onToggleMic,
  onToggleCamera,
}: FloatingControlsProps) {
  const live = phase === 'recording' || phase === 'paused';

  return (
    <div className="flex h-screen flex-col gap-1.5 bg-canvas p-1 select-none">
      {camera && (
        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          <div className="aspect-square h-full max-w-full overflow-hidden rounded-full border-2 border-white/70 bg-surface-3">
            {cameraHidden ? (
              <span className="flex h-full items-center justify-center text-fg-muted">
                <VideoOff size={28} aria-label="Camera hidden" />
              </span>
            ) : (
              <StreamVideo stream={camera} label="Camera" mirrored className="object-cover" />
            )}
          </div>
          {phase === 'countdown' && (
            <span
              aria-live="assertive"
              className="absolute inset-0 flex items-center justify-center text-5xl font-bold text-white drop-shadow-lg"
            >
              {countdown}
            </span>
          )}
        </div>
      )}

      <div className="flex h-9 shrink-0 items-center gap-0.5 rounded-lg border border-line bg-surface px-1.5 [&_button]:size-7">
        <span
          aria-hidden
          className={cn('ml-0.5 size-2 shrink-0 rounded-full', phase === 'recording' ? 'animate-pulse bg-rec' : 'bg-warning')}
        />
        <span className="ml-1 min-w-0 flex-1 truncate font-mono text-xs font-semibold tabular-nums" role="timer" aria-live="off">
          {phase === 'countdown' ? `Starts in ${countdown}` : phase === 'saving' ? 'Saving…' : formatClock(elapsedMs)}
        </span>
        {live && (
          <>
            {micAvailable && (
              <IconButton
                icon={micMuted ? MicOff : Mic}
                label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
                size="sm"
                tone={micMuted ? 'danger' : 'default'}
                onClick={onToggleMic}
              />
            )}
            {camera && (
              <IconButton
                icon={cameraHidden ? VideoOff : Video}
                label={cameraHidden ? 'Show camera' : 'Hide camera'}
                size="sm"
                tone={cameraHidden ? 'danger' : 'default'}
                onClick={onToggleCamera}
              />
            )}
            <IconButton
              icon={phase === 'paused' ? Play : Pause}
              label={phase === 'paused' ? 'Resume recording' : 'Pause recording'}
              size="sm"
              onClick={phase === 'paused' ? onResume : onPause}
            />
            <IconButton
              icon={Square}
              label="Stop recording"
              size="sm"
              tooltipAlign="end"
              className="bg-rec/15 text-rec hover:bg-rec/25 hover:text-rec"
              onClick={onStop}
            />
          </>
        )}
      </div>
    </div>
  );
}
