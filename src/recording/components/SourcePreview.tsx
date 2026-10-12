import { AppWindow, Monitor, MonitorUp, PanelTop, RefreshCw, Square, Volume2, VolumeX } from 'lucide-react';
import { CAPTURE_SOURCE_NOUN } from '@/shared/captureSources';
import { Button, EmptyState, Panel } from '@/shared/components';
import type { CaptureSource, SelectedSurface } from '@/types';
import { StreamVideo } from './StreamVideo';

const SURFACE_ICONS = { monitor: Monitor, window: AppWindow, browser: PanelTop, unknown: Monitor };
const SURFACE_NAMES = { monitor: 'Screen', window: 'Window', browser: 'Browser tab', unknown: 'Shared surface' };

export interface SourcePreviewProps {
  source: CaptureSource;
  stream: MediaStream | null;
  surface: SelectedSurface | null;
  selecting: boolean;
  disabled: boolean;
  onSelect: () => void;
  onStop: () => void;
}

export function SourcePreview({ source, stream, surface, selecting, disabled, onSelect, onStop }: SourcePreviewProps) {
  const SurfaceIcon = surface ? SURFACE_ICONS[surface.surface] : Monitor;

  return (
    <Panel className="p-3">
      <div className="relative aspect-video overflow-hidden rounded-xl border border-line bg-black/60">
        {stream ? (
          <StreamVideo stream={stream} label="Live preview of the shared surface" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-[radial-gradient(ellipse_at_center,var(--color-surface-2),var(--color-canvas))]">
            <EmptyState
              icon={MonitorUp}
              title={`Choose the ${CAPTURE_SOURCE_NOUN[source]} to record`}
              description="Chrome will open its sharing picker. You can pick any screen, window or tab there."
              action={
                <Button variant="primary" icon={MonitorUp} loading={selecting} disabled={disabled} onClick={onSelect}>
                  Choose {CAPTURE_SOURCE_NOUN[source]}
                </Button>
              }
            />
          </div>
        )}
      </div>

      {surface && (
        <div className="mt-3 flex flex-wrap items-center gap-3 px-1">
          <span className="flex size-9 items-center justify-center rounded-lg bg-surface-3 text-accent-2">
            <SurfaceIcon size={16} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium" title={surface.label}>
              {surface.label}
            </p>
            <p className="flex flex-wrap items-center gap-x-2 text-xs text-fg-subtle">
              <span>{SURFACE_NAMES[surface.surface]}</span>
              {surface.width && surface.height && (
                <span>
                  · {surface.width}×{surface.height}
                </span>
              )}
              {surface.frameRate && <span>· {surface.frameRate} fps</span>}
              <span className="inline-flex items-center gap-1">
                · {surface.hasAudio ? <Volume2 size={12} aria-hidden /> : <VolumeX size={12} aria-hidden />}
                {surface.hasAudio ? 'Audio shared' : 'No audio'}
              </span>
            </p>
          </div>
          <Button size="sm" icon={RefreshCw} loading={selecting} disabled={disabled} onClick={onSelect}>
            Change source
          </Button>
          <Button size="sm" variant="danger" icon={Square} onClick={onStop}>
            Stop sharing
          </Button>
        </div>
      )}
    </Panel>
  );
}
