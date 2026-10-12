import { Mic, RotateCcw, Video } from 'lucide-react';
import type { MediaDeviceOption } from '@/services/media/userMedia';
import { Button, Panel, SegmentedControl, Select, Toggle } from '@/shared/components';
import type { CameraBubbleSize } from '@/types';
import { MicLevelMeter } from './MicLevelMeter';
import { StreamVideo } from './StreamVideo';

interface DevicePanelProps {
  kind: 'camera' | 'microphone';
  /** Device requested for this session. */
  enabled: boolean;
  stream: MediaStream | null;
  error: string | null;
  pending: boolean;
  usingFallback: boolean;
  devices: MediaDeviceOption[];
  deviceId: string;
  /** Settings are locked while a recording is active. */
  locked: boolean;
  /** This device is part of the active recording, so it can be muted/hidden. */
  inRecording: boolean;
  /** Muted (microphone) or hidden (camera) during recording. */
  suppressed: boolean;
  onToggle: (enabled: boolean) => void;
  onToggleSuppressed: () => void;
  onDeviceChange: (deviceId: string) => void;
  onRetry: () => void;
  /** Show an inline preview (the camera is not visible as a bubble over the screen preview). */
  showPreview?: boolean;
  bubbleSize?: CameraBubbleSize;
  onBubbleSizeChange?: (size: CameraBubbleSize) => void;
}

const BUBBLE_SIZES = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
] as const;

const COPY = {
  camera: { label: 'Camera', icon: Video, live: 'Live preview', suppressed: 'Hidden — records black frames', unsuppress: 'Show camera' },
  microphone: { label: 'Microphone', icon: Mic, live: 'Listening', suppressed: 'Muted — records silence', unsuppress: 'Microphone' },
};

/** A device cannot join a recording already in progress, so retry is only offered before recording. */
function DeviceError({ message, onRetry, canRetry }: { message: string; onRetry: () => void; canRetry: boolean }) {
  return (
    <div role="alert" className="mt-3 space-y-2 rounded-xl border border-danger/30 bg-danger/10 p-3">
      <p className="text-xs text-danger">{message}</p>
      {canRetry && (
        <Button size="sm" icon={RotateCcw} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function DevicePanel(props: DevicePanelProps) {
  const { kind, enabled, stream, error, pending, locked, inRecording, suppressed } = props;
  const copy = COPY[kind];

  const status = !enabled
    ? 'Off'
    : stream
      ? props.usingFallback
        ? 'Selected device unavailable — using default'
        : copy.live
      : pending
        ? 'Connecting…'
        : 'Unavailable';

  const deviceOptions = [
    { value: '', label: 'System default' },
    ...props.devices.map((device) => ({ value: device.deviceId, label: device.label })),
  ];

  return (
    <Panel>
      {locked ? (
        <Toggle
          icon={copy.icon}
          label={inRecording && kind === 'camera' ? copy.unsuppress : copy.label}
          description={inRecording ? (suppressed ? copy.suppressed : copy.live) : 'Turn on before recording starts'}
          checked={inRecording && !suppressed}
          disabled={!inRecording}
          onCheckedChange={props.onToggleSuppressed}
        />
      ) : (
        <Toggle icon={copy.icon} label={copy.label} description={status} checked={enabled} onCheckedChange={props.onToggle} />
      )}

      {enabled && (
        <div className="mt-3 space-y-3">
          <Select
            label={`${copy.label} device`}
            options={deviceOptions}
            value={props.devices.some((d) => d.deviceId === props.deviceId) ? props.deviceId : ''}
            onValueChange={props.onDeviceChange}
            disabled={locked}
          />
          {kind === 'camera' && stream && !props.showPreview && props.onBubbleSizeChange && (
            <SegmentedControl
              label="Camera bubble size"
              options={BUBBLE_SIZES}
              value={props.bubbleSize ?? 'medium'}
              onChange={props.onBubbleSizeChange}
            />
          )}
          {kind === 'camera' && stream && props.showPreview && (
            <div className="aspect-video overflow-hidden rounded-xl border border-line">
              <StreamVideo stream={stream} label="Camera preview" mirrored className="object-cover" />
            </div>
          )}
          {kind === 'microphone' && stream && <MicLevelMeter stream={stream} />}
        </div>
      )}
      {enabled && error && (
        <DeviceError message={error} onRetry={props.onRetry} canRetry={!locked} />
      )}
    </Panel>
  );
}
