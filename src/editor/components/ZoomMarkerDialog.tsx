import { useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import { Crosshair, Focus, MousePointer2, Sparkles, ZoomIn } from 'lucide-react';
import { Button, Dialog, SegmentedControl, TextField, Toggle } from '@/shared/components';
import { ZOOM_LIMITS, type ZoomEffectType, type ZoomMarker, type ZoomPositionMode } from '@/types';
import type { MarkerPatch } from '@/services/zoom/markers';

const POSITION_MODES = [
  { value: 'fixed', label: 'Fixed', icon: Focus },
  { value: 'follow-cursor', label: 'Follow cursor', icon: MousePointer2 },
] as const satisfies ReadonlyArray<{ value: ZoomPositionMode; label: string; icon: typeof Focus }>;

const EFFECTS = [
  { value: 'zoom', label: 'Zoom', icon: ZoomIn },
  { value: 'highlight', label: 'Highlight', icon: Sparkles },
] as const satisfies ReadonlyArray<{ value: ZoomEffectType; label: string; icon: typeof ZoomIn }>;

interface FormState {
  time: string;
  scale: number;
  duration: string;
  transition: string;
  x: string;
  y: string;
  positionMode: ZoomPositionMode;
  effect: ZoomEffectType;
  annotation: string;
  enabled: boolean;
}

const seconds = (ms: number) => String(Math.round(ms / 100) / 10);
const percent = (value: number) => String(Math.round(value * 1000) / 10);

function toForm(marker: ZoomMarker): FormState {
  return {
    time: seconds(marker.timeMs),
    scale: marker.scale,
    duration: seconds(marker.durationMs),
    transition: seconds(marker.transitionMs),
    x: percent(marker.position.x),
    y: percent(marker.position.y),
    positionMode: marker.positionMode,
    effect: marker.effect,
    annotation: marker.annotation ?? '',
    enabled: marker.enabled,
  };
}

/** Parses the form; returns field errors or a patch (values are clamped again on save). */
function toPatch(form: FormState, durationMs: number): { patch: MarkerPatch } | { errors: Partial<Record<keyof FormState, string>> } {
  const errors: Partial<Record<keyof FormState, string>> = {};
  const num = (key: keyof FormState, value: string, min: number, max: number, label: string) => {
    const parsed = Number(value.replace(',', '.'));
    if (value.trim() === '' || !Number.isFinite(parsed) || parsed < min || parsed > max) {
      errors[key] = `${label} must be between ${min} and ${max}.`;
    }
    return parsed;
  };
  const time = num('time', form.time, 0, Math.round(durationMs / 100) / 10, 'Time');
  const duration = num('duration', form.duration, ZOOM_LIMITS.durationMs.min / 1000, ZOOM_LIMITS.durationMs.max / 1000, 'Duration');
  const transition = num('transition', form.transition, ZOOM_LIMITS.transitionMs.min / 1000, ZOOM_LIMITS.transitionMs.max / 1000, 'Transition');
  const x = num('x', form.x, 0, 100, 'X');
  const y = num('y', form.y, 0, 100, 'Y');
  if (Object.keys(errors).length) return { errors };
  return {
    patch: {
      timeMs: time * 1000,
      scale: form.scale,
      durationMs: duration * 1000,
      transitionMs: transition * 1000,
      position: { x: x / 100, y: y / 100 },
      positionMode: form.positionMode,
      effect: form.effect,
      annotation: form.annotation,
      enabled: form.enabled,
    },
  };
}

export function ZoomMarkerDialog({
  marker,
  durationMs,
  thumbnailUrl,
  aspectRatio,
  onClose,
  onSave,
}: {
  marker: ZoomMarker | null;
  durationMs: number;
  thumbnailUrl: string | null;
  aspectRatio: number;
  onClose: () => void;
  onSave: (id: string, patch: MarkerPatch) => Promise<void>;
}) {
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (marker) {
      setForm(toForm(marker));
      setErrors({});
    }
  }, [marker]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => current && { ...current, [key]: value });
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const pickPosition = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    set('x', percent((event.clientX - rect.left) / rect.width));
    set('y', percent((event.clientY - rect.top) / rect.height));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!marker || !form) return;
    const result = toPatch(form, durationMs);
    if ('errors' in result) return setErrors(result.errors);
    setSaving(true);
    try {
      await onSave(marker.id, result.patch);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const x = Number(form?.x) / 100;
  const y = Number(form?.y) / 100;

  return (
    <Dialog open={marker !== null} onClose={saving ? () => undefined : onClose} title="Edit zoom effect" size="lg">
      {form && (
        <form onSubmit={(event) => void submit(event)} className="grid gap-5 md:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-3">
            <p className="text-sm font-medium">Position</p>
            <button
              type="button"
              onClick={pickPosition}
              aria-label="Click to set the zoom position"
              className="relative block w-full cursor-crosshair overflow-hidden rounded-xl border border-line-strong bg-black bg-cover bg-center"
              style={{ aspectRatio, backgroundImage: thumbnailUrl ? `url(${thumbnailUrl})` : undefined }}
            >
              {Number.isFinite(x) && Number.isFinite(y) && (
                <span
                  aria-hidden
                  className="absolute size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent-2 bg-accent-2/20 shadow-[0_0_0_4px_rgb(0_0_0/0.4)]"
                  style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
                >
                  <Crosshair size={14} className="absolute inset-0 m-auto text-white" />
                </span>
              )}
            </button>
            <div className="grid grid-cols-2 gap-3">
              <TextField label="X (%)" inputMode="decimal" value={form.x} error={errors.x} onValueChange={(v) => set('x', v)} />
              <TextField label="Y (%)" inputMode="decimal" value={form.y} error={errors.y} onValueChange={(v) => set('y', v)} />
            </div>
            <TextField
              label="Annotation (optional)"
              maxLength={200}
              placeholder="e.g. Click “Publish”"
              value={form.annotation}
              onValueChange={(v) => set('annotation', v)}
            />
          </div>

          <div className="space-y-4">
            <TextField label="Time (seconds)" inputMode="decimal" value={form.time} error={errors.time} onValueChange={(v) => set('time', v)} />
            <div>
              <label htmlFor="zoom-level" className="flex justify-between text-sm font-medium">
                Zoom level <output className="font-mono text-fg-muted">{form.scale.toFixed(1)}×</output>
              </label>
              <input
                id="zoom-level"
                type="range"
                min={ZOOM_LIMITS.scale.min}
                max={ZOOM_LIMITS.scale.max}
                step={0.1}
                value={form.scale}
                disabled={form.effect !== 'zoom'}
                onChange={(event) => set('scale', Number(event.target.value))}
                className="mt-2 w-full accent-[var(--color-accent)]"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <TextField label="Hold (s)" inputMode="decimal" value={form.duration} error={errors.duration} onValueChange={(v) => set('duration', v)} />
              <TextField label="Transition (s)" inputMode="decimal" value={form.transition} error={errors.transition} onValueChange={(v) => set('transition', v)} />
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Effect</p>
              <SegmentedControl label="Effect" options={EFFECTS} value={form.effect} onChange={(v) => set('effect', v)} />
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Position mode</p>
              <SegmentedControl label="Position mode" options={POSITION_MODES} value={form.positionMode} onChange={(v) => set('positionMode', v)} />
            </div>
            <Toggle label="Enabled" description="Disabled effects are kept but not applied" checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} />
          </div>

          <div className="flex justify-end gap-2 md:col-span-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={saving}>
              Save effect
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
