import type { ReactNode } from 'react';
import { AppWindow, Monitor, MonitorUp, MousePointerClick, PanelTop, Volume2, VolumeX } from 'lucide-react';
import { CAPTURE_SOURCE_NOUN } from '@/shared/captureSources';
import { Button, EmptyState, Panel } from '@/shared/components';
import type { CaptureSource, CaptureTarget, SelectedSurface } from '@/types';
import { cn } from '@/utils/cn';
import { StreamVideo } from './StreamVideo';

const SURFACE_ICONS = { monitor: Monitor, window: AppWindow, browser: PanelTop, unknown: Monitor };
const SURFACE_NAMES = { monitor: 'Screen', window: 'Window', browser: 'Browser tab', unknown: 'Shared surface' };

/** Explains honestly whether audio comes with the chosen surface; Chrome's support varies by source. */
export function describeSurfaceAudio(surface: SelectedSurface, audioRequested: boolean): string {
  if (surface.hasAudio) return surface.surface === 'browser' ? 'Tab audio included' : 'System audio included';
  if (!audioRequested) return 'Tab/system audio is turned off';
  if (surface.surface === 'window') return 'Chrome does not share audio from windows';
  if (surface.surface === 'browser') return 'Tab audio was not shared in Chrome’s picker';
  return 'System audio not shared (Chrome offers it on Windows and ChromeOS)';
}

export interface SourcePreviewProps {
  source: CaptureSource;
  stream: MediaStream | null;
  surface: SelectedSurface | null;
  audioRequested: boolean;
  selecting: boolean;
  disabled: boolean;
  recording: boolean;
  /** The tab ZoomCapture was opened on, offered for direct capture with click tracking. */
  target?: CaptureTarget | null;
  onSelect: () => void;
  onSelectTarget?: () => void;
  /** Rendered over the video (camera bubble, countdown). */
  overlay?: ReactNode;
  /** Transport controls. */
  footer?: ReactNode;
}

export function SourcePreview({
  source,
  stream,
  surface,
  audioRequested,
  selecting,
  disabled,
  recording,
  target,
  onSelect,
  onSelectTarget,
  overlay,
  footer,
}: SourcePreviewProps) {
  const SurfaceIcon = surface ? SURFACE_ICONS[surface.surface] : Monitor;

  return (
    <Panel className="p-3">
      <div
        className={cn(
          'relative aspect-video overflow-hidden rounded-xl border bg-black/60 transition-colors',
          recording ? 'border-rec/70 shadow-[0_0_0_1px] shadow-rec/40' : 'border-line',
        )}
      >
        {stream ? (
          <>
            <StreamVideo stream={stream} label="Live preview of the shared surface" />
            {overlay}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-[radial-gradient(ellipse_at_center,var(--color-surface-2),var(--color-canvas))]">
            {target && onSelectTarget ? (
              <EmptyState
                icon={MousePointerClick}
                title={`Record “${target.title || target.origin}”`}
                description="ZoomCapture was opened on this tab, so it can record it directly and track your clicks there for automatic zoom."
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button variant="ghost" disabled={disabled || selecting} onClick={onSelect}>
                      Choose another tab
                    </Button>
                    <Button variant="primary" icon={PanelTop} loading={selecting} disabled={disabled} onClick={onSelectTarget}>
                      Record this tab
                    </Button>
                  </div>
                }
              />
            ) : (
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
            )}
          </div>
        )}
      </div>

      {surface && (
        <div className="mt-3 flex items-center gap-3 px-1">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-accent-2">
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
                {describeSurfaceAudio(surface, audioRequested)}
              </span>
            </p>
          </div>
        </div>
      )}

      {footer && <div className="mt-3 border-t border-line px-1 pt-3">{footer}</div>}
    </Panel>
  );
}
