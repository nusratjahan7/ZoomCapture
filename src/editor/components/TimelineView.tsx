import { AudioLines, Music, Rows3, Video, Webcam, ZoomIn } from 'lucide-react';
import { EmptyState, Panel } from '@/shared/components';
import type { Timeline, TrackKind } from '@/types';
import { formatDuration } from '@/utils/format';

const TRACK_ICONS: Record<TrackKind, typeof Video> = { video: Video, camera: Webcam, audio: AudioLines, music: Music };
const TRACK_COLORS: Record<TrackKind, string> = {
  video: 'bg-accent/30 border-accent/60',
  camera: 'bg-accent-2/20 border-accent-2/50',
  audio: 'bg-success/20 border-success/50',
  music: 'bg-warning/20 border-warning/50',
};

/** Read-only rendering of the timeline model. Editing interactions come with the editor module. */
export function TimelineView({ timeline }: { timeline: Timeline }) {
  const { durationMs, tracks, zoomMarkers } = timeline;
  const percent = (ms: number) => `${durationMs > 0 ? (ms / durationMs) * 100 : 0}%`;
  const ticks = durationMs > 0 ? Array.from({ length: 5 }, (_, i) => (durationMs * i) / 4) : [];

  return (
    <Panel title="Timeline" description={`${tracks.length} tracks · ${zoomMarkers.length} zoom markers`}>
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
            <div className="relative h-7 flex-1 rounded-md bg-surface-2">
              {zoomMarkers.map((marker) => (
                <span
                  key={marker.id}
                  title={`${marker.scale}× zoom, ${formatDuration(marker.startMs)}–${formatDuration(marker.endMs)}`}
                  className="absolute inset-y-1 rounded border border-warning/60 bg-warning/20"
                  style={{ left: percent(marker.startMs), width: percent(marker.endMs - marker.startMs) }}
                />
              ))}
            </div>
          </div>

          {tracks.map((track) => {
            const Icon = TRACK_ICONS[track.kind];
            return (
              <div key={track.id} className="flex items-center gap-2">
                <span className="flex w-26 shrink-0 items-center gap-1.5 truncate text-xs text-fg-muted">
                  <Icon size={13} aria-hidden /> {track.name}
                </span>
                <div className="relative h-9 flex-1 rounded-md bg-surface-2">
                  {track.clips.map((clip) => (
                    <span
                      key={clip.id}
                      className={`absolute inset-y-1 rounded border ${TRACK_COLORS[track.kind]}`}
                      style={{ left: percent(clip.startMs), width: percent(clip.sourceOutMs - clip.sourceInMs) }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
