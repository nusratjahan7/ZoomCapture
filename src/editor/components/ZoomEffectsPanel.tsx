import { Copy, Info, MousePointer2, MousePointerClick, Plus, RefreshCw, Sparkles, Trash2, ZoomIn } from 'lucide-react';
import { Button, IconButton } from '@/shared/components';
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
}

/** What click tracking captured for this recording, in one line. */
export function trackingSummary(tracking: ClickTrackingInfo, clicks: number): string {
  const count = `${clicks} ${clicks === 1 ? 'click' : 'clicks'}`;
  if (tracking.mode === 'screen') return `${count} tracked in Chrome tabs`;
  if (tracking.mode === 'tab') return `${count} tracked${tracking.origin ? ` on ${tracking.origin}` : ''}`;
  return 'Clicks were not tracked';
}

/**
 * Zoom effects: automatic ones made from tracked clicks, and manual ones. Fits a narrow side
 * panel: actions wrap, rows stay on one line.
 */
export function ZoomEffectsPanel(props: ZoomEffectsPanelProps) {
  const { markers, clicks, clickTracking } = props;
  const hasAuto = markers.some((marker) => marker.origin === 'auto');

  return (
    <section className="space-y-3" aria-labelledby="zoom-effects-title">
      <header>
        <h3 id="zoom-effects-title" className="text-sm font-semibold">
          Zoom effects
        </h3>
        <p className="text-xs text-fg-subtle">
          {markers.length} {markers.length === 1 ? 'effect' : 'effects'} · {trackingSummary(clickTracking, clicks)}
        </p>
      </header>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" icon={Plus} disabled={props.busy} onClick={props.onAdd}>
          Add at playhead
        </Button>
        {clicks > 0 && (
          <Button size="sm" variant="ghost" icon={RefreshCw} disabled={props.busy} onClick={props.onRegenerate}>
            {hasAuto ? 'Regenerate' : 'Generate from clicks'}
          </Button>
        )}
      </div>
      {clickTracking.mode === 'unsupported' && (
        <p className="flex gap-2 rounded-lg bg-surface-2 p-2.5 text-xs text-fg-muted">
          <Info size={14} aria-hidden className="mt-0.5 shrink-0" />
          <span>
            Clicks were not tracked for this recording. {clickTracking.reason} Use “Add at playhead” to place zoom effects.
          </span>
        </p>
      )}
      {clickTracking.mode !== 'unsupported' && clicks === 0 && (
        <p className="flex gap-2 rounded-lg bg-surface-2 p-2.5 text-xs text-fg-muted">
          <MousePointerClick size={14} aria-hidden className="mt-0.5 shrink-0" />
          <span>
            Tracking was on, but no clicks were captured{clickTracking.mode === 'screen' ? ' inside Chrome tabs (clicks in other apps can’t be seen)' : ''}.
            {clickTracking.reason ? ` ${clickTracking.reason}` : ''}
          </span>
        </p>
      )}
      {markers.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-4 text-center text-xs text-fg-subtle">No zoom effects yet.</p>
      ) : (
        <ul className="space-y-1" aria-label="Zoom effects">
          {markers.map((marker) => {
            const Icon = marker.effect === 'highlight' ? Sparkles : ZoomIn;
            const time = formatTime(marker.timeMs);
            return (
              <li
                key={marker.id}
                className={cn('group flex items-center gap-2 rounded-lg px-1.5 py-1', marker.id === props.selectedId ? 'bg-accent-soft' : 'hover:bg-surface-2')}
              >
                <button
                  type="button"
                  onClick={() => props.onEdit(marker)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left"
                  aria-label={`Edit zoom effect at ${time}`}
                >
                  <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg', marker.enabled ? 'bg-accent/20 text-accent' : 'bg-surface-3 text-fg-subtle')}>
                    <Icon size={14} aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className={cn('block truncate text-[13px] font-medium tabular-nums', !marker.enabled && 'text-fg-subtle line-through')}>
                      {time} · {marker.effect === 'zoom' ? `${marker.scale.toFixed(1)}×` : 'Highlight'}
                    </span>
                    <span className="flex items-center gap-1 truncate text-[11px] text-fg-subtle">
                      {marker.positionMode === 'follow-cursor' && <MousePointer2 size={10} aria-label="Follows the cursor" className="shrink-0" />}
                      {(marker.durationMs / 1000).toFixed(1)} s · {marker.origin === 'auto' ? 'from click' : 'manual'}
                      {marker.annotation && ` · “${marker.annotation}”`}
                    </span>
                  </span>
                </button>
                <input
                  type="checkbox"
                  checked={marker.enabled}
                  disabled={props.busy}
                  onChange={(event) => props.onToggle(marker, event.target.checked)}
                  className="size-4 shrink-0 accent-[var(--color-accent)]"
                  aria-label={`Enable zoom effect at ${time}`}
                />
                <IconButton icon={Copy} label={`Duplicate zoom effect at ${time}`} size="sm" className="size-7" disabled={props.busy} onClick={() => props.onDuplicate(marker)} />
                <IconButton
                  icon={Trash2}
                  label={`Delete zoom effect at ${time}`}
                  size="sm"
                  tone="danger"
                  tooltipAlign="end"
                  className="size-7"
                  disabled={props.busy}
                  onClick={() => props.onDelete(marker)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
