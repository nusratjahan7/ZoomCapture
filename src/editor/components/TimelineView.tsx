import { useRef, useState, type PointerEvent } from 'react';
import { AudioLines, Music, Rows3, Video, Webcam, ZoomIn } from 'lucide-react';
import { markerSpan } from '@/services/zoom/markers';
import { EmptyState, Panel } from '@/shared/components';
import type { InteractionEvent, Timeline, TrackKind } from '@/types';
import { cn } from '@/utils/cn';
import { formatDuration } from '@/utils/format';

const TRACK_ICONS: Record<TrackKind, typeof Video> = { video: Video, camera: Webcam, audio: AudioLines, music: Music };
const TRACK_COLORS: Record<TrackKind, string> = {
  video: 'bg-accent/30 border-accent/60',
  camera: 'bg-accent-2/20 border-accent-2/50',
  audio: 'bg-success/20 border-success/50',
  music: 'bg-warning/20 border-warning/50',
};

export interface TimelineViewProps {
  timeline: Timeline;
  interactions?: InteractionEvent[];
  currentMs?: number;
  selectedMarkerId?: string | null;
  onSeek?: (ms: number) => void;
  onMarkerSelect?: (id: string) => void;
  /** A zoom effect was dragged to a new time. */
  onMarkerMove?: (id: string, timeMs: number) => void;
}

/** Pointer movement (px) below which a press on a marker is a click, not a drag. */
const DRAG_THRESHOLD_PX = 4;

/**
 * Timeline of tracks, zoom effects and tracked clicks. Press and drag on a track to scrub (the
 * preview follows); drag a zoom effect to move it in time. Clip editing comes with the editor module.
 */
export function TimelineView({
  timeline,
  interactions = [],
  currentMs,
  selectedMarkerId,
  onSeek,
  onMarkerSelect,
  onMarkerMove,
}: TimelineViewProps) {
  const { durationMs, tracks, zoomMarkers } = timeline;
  const percent = (ms: number) => `${durationMs > 0 ? (Math.min(durationMs, Math.max(0, ms)) / durationMs) * 100 : 0}%`;
  const ticks = durationMs > 0 ? Array.from({ length: 5 }, (_, i) => (durationMs * i) / 4) : [];
  const scrubbing = useRef(false);
  // The drag is tracked in a ref (read synchronously on release); state only drives the redraw.
  const drag = useRef<{ id: string; startX: number; timeMs: number; width: number; moved: boolean; toMs: number } | null>(null);
  const [dragged, setDragged] = useState<{ id: string; timeMs: number } | null>(null);

  const timeAt = (event: PointerEvent<HTMLElement>, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * durationMs;
  };
  const scrubHandlers = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (!onSeek || event.button !== 0) return;
      scrubbing.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      onSeek(timeAt(event, event.currentTarget));
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (scrubbing.current) onSeek?.(timeAt(event, event.currentTarget));
    },
    onPointerUp: () => {
      scrubbing.current = false;
    },
    onPointerCancel: () => {
      scrubbing.current = false;
    },
  };

  const markerHandlers = (id: string, timeMs: number) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (!onMarkerMove || event.button !== 0) return;
      const track = event.currentTarget.parentElement!;
      drag.current = { id, startX: event.clientX, timeMs, width: track.getBoundingClientRect().width, moved: false, toMs: timeMs };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
      const current = drag.current;
      if (!current || current.id !== id) return;
      const dx = event.clientX - current.startX;
      if (!current.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      current.moved = true;
      const next = Math.round(Math.min(durationMs, Math.max(0, current.timeMs + (dx / current.width) * durationMs)));
      current.toMs = next;
      setDragged({ id, timeMs: next });
      onSeek?.(next);
    },
    onPointerUp: () => {
      const current = drag.current;
      if (current?.moved && current.id === id) onMarkerMove?.(id, current.toMs);
      setDragged(null);
    },
    onPointerCancel: () => {
      drag.current = null;
      setDragged(null);
    },
  });

  const playhead =
    currentMs !== undefined && durationMs > 0 ? (
      <span aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-rec" style={{ left: percent(currentMs) }} />
    ) : null;

  return (
    <Panel title="Timeline" description={`${tracks.length} tracks · ${zoomMarkers.length} zoom effects · ${interactions.length} clicks`}>
      {durationMs === 0 || tracks.length === 0 ? (
        <EmptyState compact icon={Rows3} title="The timeline is empty" />
      ) : (
        <div className="space-y-1.5" role="group" aria-label="Timeline tracks">
          <div className="relative ml-28 h-5 text-[10px] text-fg-subtle" aria-hidden>
            {ticks.map((ms, i) => (
              <span key={i} className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full" style={{ left: percent(ms) }}>
                {formatDuration(ms)}
              </span>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <span className="flex w-26 shrink-0 items-center gap-1.5 text-xs text-fg-muted">
              <ZoomIn size={13} aria-hidden /> Zoom
            </span>
            <div className="relative h-9 flex-1 touch-none rounded-md bg-surface-2" {...scrubHandlers} data-testid="zoom-track">
              {interactions.map((event) => (
                <span
                  key={event.id}
                  aria-hidden
                  title={`Click at ${formatDuration(event.timeMs)}`}
                  className="absolute bottom-0 h-1.5 w-0.5 -translate-x-1/2 rounded-full bg-fg-subtle"
                  style={{ left: percent(event.timeMs) }}
                />
              ))}
              {zoomMarkers.map((stored) => {
                const marker = dragged?.id === stored.id ? { ...stored, timeMs: dragged.timeMs } : stored;
                const { startMs, endMs } = markerSpan(marker);
                return (
                  <button
                    key={marker.id}
                    type="button"
                    aria-label={`Zoom effect at ${formatDuration(marker.timeMs)}, ${marker.scale}×${marker.enabled ? '' : ', disabled'}`}
                    aria-pressed={marker.id === selectedMarkerId}
                    title={onMarkerMove ? 'Click to edit, drag to move' : undefined}
                    {...markerHandlers(stored.id, stored.timeMs)}
                    onClick={(event) => {
                      event.stopPropagation();
                      // The click that ends a drag is not a selection.
                      if (drag.current?.moved) {
                        drag.current = null;
                        return;
                      }
                      drag.current = null;
                      onMarkerSelect?.(marker.id);
                    }}
                    className={cn(
                      'absolute inset-y-1 touch-none overflow-hidden rounded border transition-colors',
                      onMarkerMove && 'cursor-grab active:cursor-grabbing',
                      marker.enabled ? 'border-warning/60 bg-warning/15 hover:bg-warning/25' : 'border-line-strong bg-surface-3 opacity-60',
                      marker.id === selectedMarkerId && 'ring-2 ring-accent-2',
                    )}
                    style={{ left: percent(startMs), width: `calc(${percent(endMs)} - ${percent(startMs)})` }}
                  >
                    <span
                      aria-hidden
                      className={cn('absolute inset-y-0', marker.enabled ? 'bg-warning/30' : 'bg-line')}
                      style={{
                        left: `${(marker.transitionMs / (endMs - startMs)) * 100}%`,
                        width: `${(marker.durationMs / (endMs - startMs)) * 100}%`,
                      }}
                    />
                  </button>
                );
              })}
              {playhead}
            </div>
          </div>

          {tracks.map((track) => {
            const Icon = TRACK_ICONS[track.kind];
            return (
              <div key={track.id} className="flex items-center gap-2">
                <span className="flex w-26 shrink-0 items-center gap-1.5 truncate text-xs text-fg-muted">
                  <Icon size={13} aria-hidden /> {track.name}
                </span>
                <div className="relative h-9 flex-1 touch-none rounded-md bg-surface-2" {...scrubHandlers}>
                  {track.clips.map((clip) => (
                    <span
                      key={clip.id}
                      className={`absolute inset-y-1 rounded border ${TRACK_COLORS[track.kind]}`}
                      style={{ left: percent(clip.startMs), width: percent(clip.sourceOutMs - clip.sourceInMs) }}
                    />
                  ))}
                  {playhead}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
