import { Copy, Info, MousePointer2, Pencil, Plus, RefreshCw, Sparkles, Trash2, ZoomIn } from 'lucide-react';
import { Button, IconButton, Panel } from '@/shared/components';
import type { ClickTrackingInfo, ZoomMarker } from '@/types';
import { cn } from '@/utils/cn';

const formatTime = (ms: number) => {
  const total = ms / 1000;
  return `${Math.floor(total / 60)}:${(total % 60).toFixed(1).padStart(4, '0')}`;
};

export interface ZoomEffectsPanelProps {
  markers: ZoomMarker[];
  clicks: number;
  clickTracking: ClickTrackingInfo;
  selectedId: string | null;
  busy: boolean;
  onAdd: () => void;
  onEdit: (marker: ZoomMarker) => void;
  onDuplicate: (marker: ZoomMarker) => void;
  onDelete: (marker: ZoomMarker) => void;
  onToggle: (marker: ZoomMarker, enabled: boolean) => void;
  onRegenerate: () => void;
  onSelect: (marker: ZoomMarker) => void;
}

/** List of zoom effects with add / edit / duplicate / delete / enable, and regeneration from clicks. */
export function ZoomEffectsPanel(props: ZoomEffectsPanelProps) {
  const { markers, clicks, clickTracking } = props;
  const hasAuto = markers.some((marker) => marker.origin === 'auto');

  return (
    <Panel
      title="Zoom effects"
      description={`${markers.length} ${markers.length === 1 ? 'effect' : 'effects'} · ${clicks} tracked ${clicks === 1 ? 'click' : 'clicks'}`}
      actions={
        <div className="flex gap-1.5">
          {clicks > 0 && (
            <Button size="sm" variant="ghost" icon={RefreshCw} disabled={props.busy} onClick={props.onRegenerate}>
              {hasAuto ? 'Regenerate' : 'Generate from clicks'}
            </Button>
          )}
          <Button size="sm" icon={Plus} disabled={props.busy} onClick={props.onAdd}>
            Add at playhead
          </Button>
        </div>
      }
    >
      {clickTracking.mode === 'unsupported' && (
        <p className="mb-3 flex gap-2 rounded-lg bg-surface-2 p-2.5 text-xs text-fg-muted">
          <Info size={14} aria-hidden className="mt-0.5 shrink-0" />
          <span>
            Clicks were not tracked for this recording. {clickTracking.reason} Use “Add at playhead” to place zoom effects.
          </span>
        </p>
      )}
      {markers.length === 0 ? (
        <p className="py-4 text-center text-sm text-fg-subtle">No zoom effects yet.</p>
      ) : (
        <ul className="divide-y divide-line" aria-label="Zoom effects">
          {markers.map((marker) => {
            const Icon = marker.effect === 'highlight' ? Sparkles : ZoomIn;
            return (
              <li
                key={marker.id}
                className={cn('flex items-center gap-3 py-2', marker.id === props.selectedId && 'bg-accent-soft -mx-2 rounded-lg px-2')}
              >
                <button
                  type="button"
                  onClick={() => props.onSelect(marker)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left"
                  aria-label={`Go to zoom effect at ${formatTime(marker.timeMs)}`}
                >
                  <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', marker.enabled ? 'bg-warning/15 text-warning' : 'bg-surface-3 text-fg-subtle')}>
                    <Icon size={15} aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className={cn('block text-sm font-medium tabular-nums', !marker.enabled && 'text-fg-subtle line-through')}>
                      {formatTime(marker.timeMs)} · {marker.effect === 'zoom' ? `${marker.scale.toFixed(1)}×` : 'Highlight'}
                    </span>
                    <span className="flex items-center gap-1.5 truncate text-xs text-fg-subtle">
                      {marker.positionMode === 'follow-cursor' && <MousePointer2 size={11} aria-label="Follows clicks" />}
                      {(marker.durationMs / 1000).toFixed(1)} s · {marker.origin === 'auto' ? 'from click' : 'manual'}
                      {marker.annotation && ` · “${marker.annotation}”`}
                    </span>
                  </span>
                </button>
                <label className="flex items-center gap-1.5 text-xs text-fg-subtle">
                  <input
                    type="checkbox"
                    checked={marker.enabled}
                    disabled={props.busy}
                    onChange={(event) => props.onToggle(marker, event.target.checked)}
                    className="size-4 accent-[var(--color-accent)]"
                    aria-label={`Enable zoom effect at ${formatTime(marker.timeMs)}`}
                  />
                </label>
                <IconButton icon={Pencil} label={`Edit zoom effect at ${formatTime(marker.timeMs)}`} size="sm" disabled={props.busy} onClick={() => props.onEdit(marker)} />
                <IconButton icon={Copy} label={`Duplicate zoom effect at ${formatTime(marker.timeMs)}`} size="sm" disabled={props.busy} onClick={() => props.onDuplicate(marker)} />
                <IconButton
                  icon={Trash2}
                  label={`Delete zoom effect at ${formatTime(marker.timeMs)}`}
                  size="sm"
                  tone="danger"
                  tooltipAlign="end"
                  disabled={props.busy}
                  onClick={() => props.onDelete(marker)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
