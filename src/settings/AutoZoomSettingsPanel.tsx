import { Info, MousePointerClick, ZoomIn } from 'lucide-react';
import { Panel, SegmentedControl, Select, Toggle } from '@/shared/components';
import type { AutoZoomSettings, TransitionSpeed } from '@/types';

const SCALE_OPTIONS = [1.25, 1.5, 1.75, 2, 2.5, 3].map((value) => ({ value: String(value), label: `${value}×` }));
const DURATION_OPTIONS = [1000, 1500, 2000, 2500, 3000, 4000, 5000].map((value) => ({
  value: String(value),
  label: `${value / 1000} s`,
}));
const SPEED_OPTIONS = [
  { value: 'slow', label: 'Slow' },
  { value: 'normal', label: 'Normal' },
  { value: 'fast', label: 'Fast' },
] as const satisfies ReadonlyArray<{ value: TransitionSpeed; label: string }>;

/** Automatic zoom preferences, with an honest description of where clicks can be tracked. */
export function AutoZoomSettingsPanel({
  value,
  onChange,
}: {
  value: AutoZoomSettings;
  onChange: (patch: Partial<AutoZoomSettings>) => void;
}) {
  return (
    <Panel title="Automatic zoom" description="Zoom effects created at the places you click while recording.">
      <div className="space-y-5">
        <div className="divide-y divide-line">
          <Toggle
            icon={MousePointerClick}
            label="Track clicks while recording a tab"
            description="Records only the position and time of each click"
            checked={value.trackClicks}
            onCheckedChange={(trackClicks) => onChange({ trackClicks })}
          />
          <Toggle
            icon={ZoomIn}
            label="Create zoom effects automatically"
            description="Off: clicks are kept, and you can generate effects later in the editor"
            checked={value.enabled}
            disabled={!value.trackClicks}
            onCheckedChange={(enabled) => onChange({ enabled })}
          />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <Select
            label="Default zoom level"
            options={SCALE_OPTIONS}
            value={String(value.scale)}
            onValueChange={(scale) => onChange({ scale: Number(scale) })}
          />
          <Select
            label="Zoom duration"
            description="How long each zoom holds after a click."
            options={DURATION_OPTIONS}
            value={String(value.durationMs)}
            onValueChange={(durationMs) => onChange({ durationMs: Number(durationMs) })}
          />
        </div>
        <div>
          <p className="text-sm font-medium">Transition speed</p>
          <p className="mt-0.5 text-xs text-fg-subtle">How quickly the view zooms in and back out.</p>
          <SegmentedControl
            className="mt-2"
            label="Transition speed"
            options={SPEED_OPTIONS}
            value={value.transitionSpeed}
            onChange={(transitionSpeed) => onChange({ transitionSpeed })}
          />
        </div>
        <p className="flex gap-2 rounded-xl bg-surface-2 p-3 text-xs leading-relaxed text-fg-muted">
          <Info size={14} aria-hidden className="mt-0.5 shrink-0" />
          <span>
            Clicks can be tracked only when you record the browser tab you opened ZoomCapture on. Chrome extensions can’t see
            clicks in other apps, so recordings of your entire screen or a window, and tabs chosen in Chrome’s picker, get no
            automatic zoom. You can still add zoom effects by hand in the editor.
          </span>
        </p>
      </div>
    </Panel>
  );
}
