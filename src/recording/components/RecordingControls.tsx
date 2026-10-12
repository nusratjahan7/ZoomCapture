import { Loader2, Mic, MicOff, Pause, PictureInPicture2, Play, RefreshCw, Square, X } from 'lucide-react';
import { Button, IconButton } from '@/shared/components';
import { describeMimeType } from '@/services/recording/mimeTypes';
import { cn } from '@/utils/cn';
import { formatClock } from '@/utils/format';
import type { FlowPhase } from '../hooks/useRecordingFlow';

export interface RecordingControlsProps {
  phase: FlowPhase;
  countdown: number;
  elapsedMs: number;
  /** Format that will be / is being recorded, e.g. "video/webm;codecs=vp9,opus". */
  mimeType: string | null;
  selecting: boolean;
  micAvailable: boolean;
  micMuted: boolean;
  floating: { supported: boolean; open: boolean; onOpen: () => void };
  onStart: () => void;
  onCancelCountdown: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onToggleMic: () => void;
  onChangeSource: () => void;
  onStopSharing: () => void;
}

/** Transport bar under the preview. Every control maps to a real recorder action. */
export function RecordingControls(props: RecordingControlsProps) {
  const { phase } = props;

  if (phase === 'setup') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-xs text-fg-subtle">
          {props.mimeType ? `Records as ${describeMimeType(props.mimeType)}` : 'This browser cannot record video.'}
        </p>
        <Button size="sm" icon={RefreshCw} loading={props.selecting} onClick={props.onChangeSource}>
          Change source
        </Button>
        <Button size="sm" variant="ghost" icon={X} onClick={props.onStopSharing}>
          Stop sharing
        </Button>
        <Button variant="record" disabled={!props.mimeType} onClick={props.onStart}>
          <span aria-hidden className="size-2.5 rounded-full bg-white" />
          Start recording
        </Button>
      </div>
    );
  }

  if (phase === 'countdown' || phase === 'starting' || phase === 'saving') {
    return (
      <div className="flex items-center gap-3" role="status">
        {phase !== 'countdown' && <Loader2 size={18} aria-hidden className="animate-spin text-fg-muted" />}
        <p className="mr-auto text-sm font-medium">
          {phase === 'countdown'
            ? `Recording starts in ${props.countdown}…`
            : phase === 'starting'
              ? 'Starting recorders…'
              : 'Saving your recording…'}
        </p>
        {phase === 'countdown' && (
          <Button size="sm" variant="ghost" icon={X} onClick={props.onCancelCountdown}>
            Cancel
          </Button>
        )}
      </div>
    );
  }

  if (phase !== 'recording' && phase !== 'paused') return null;
  const paused = phase === 'paused';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="mr-auto flex items-center gap-3">
        <span
          aria-hidden
          className={cn('size-3 rounded-full', paused ? 'bg-warning' : 'animate-pulse bg-rec shadow-[0_0_12px] shadow-rec')}
        />
        <span role="timer" aria-label="Recorded time" className="font-mono text-2xl font-semibold tabular-nums">
          {formatClock(props.elapsedMs)}
        </span>
        <span className="text-sm text-fg-muted">{paused ? 'Paused' : 'Recording'}</span>
      </div>
      {props.micAvailable && (
        <IconButton
          icon={props.micMuted ? MicOff : Mic}
          label={props.micMuted ? 'Unmute microphone' : 'Mute microphone'}
          tone={props.micMuted ? 'danger' : 'default'}
          onClick={props.onToggleMic}
        />
      )}
      {props.floating.supported && !props.floating.open && (
        <IconButton icon={PictureInPicture2} label="Show floating controls" onClick={props.floating.onOpen} />
      )}
      <Button icon={paused ? Play : Pause} onClick={paused ? props.onResume : props.onPause}>
        {paused ? 'Resume' : 'Pause'}
      </Button>
      <Button variant="record" icon={Square} onClick={props.onStop}>
        Stop
      </Button>
    </div>
  );
}
