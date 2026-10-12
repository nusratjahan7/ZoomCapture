import { Mic, RotateCcw, Video } from 'lucide-react';
import { Button, Panel, Toggle } from '@/shared/components';
import { MicLevelMeter } from './MicLevelMeter';
import { StreamVideo } from './StreamVideo';

interface DeviceState {
  enabled: boolean;
  stream: MediaStream | null;
  error: string | null;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
  onRetry: () => void;
}

function DeviceError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="mt-3 space-y-2 rounded-xl border border-danger/30 bg-danger/10 p-3">
      <p className="text-xs text-danger">{message}</p>
      <Button size="sm" icon={RotateCcw} onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function CameraPanel({ enabled, stream, error, pending, onToggle, onRetry }: DeviceState) {
  return (
    <Panel>
      <Toggle
        icon={Video}
        label="Camera"
        description={enabled ? (stream ? 'Live preview' : pending ? 'Connecting…' : 'Unavailable') : 'Off'}
        checked={enabled}
        onCheckedChange={onToggle}
      />
      {enabled && stream && (
        <div className="mt-3 aspect-video overflow-hidden rounded-xl border border-line">
          <StreamVideo stream={stream} label="Camera preview" mirrored className="object-cover" />
        </div>
      )}
      {enabled && error && <DeviceError message={error} onRetry={onRetry} />}
    </Panel>
  );
}

export function MicrophonePanel({ enabled, stream, error, pending, onToggle, onRetry }: DeviceState) {
  return (
    <Panel>
      <Toggle
        icon={Mic}
        label="Microphone"
        description={enabled ? (stream ? 'Listening' : pending ? 'Connecting…' : 'Unavailable') : 'Off'}
        checked={enabled}
        onCheckedChange={onToggle}
      />
      {enabled && stream && (
        <div className="mt-3 px-1">
          <MicLevelMeter stream={stream} />
        </div>
      )}
      {enabled && error && <DeviceError message={error} onRetry={onRetry} />}
    </Panel>
  );
}
