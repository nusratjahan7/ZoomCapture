import { RotateCcw } from 'lucide-react';
import { aspectValue } from '@/services/render/compose';
import { cameraStyleOf } from '@/services/render/enhancements';
import { Button, SegmentedControl, Toggle } from '@/shared/components';
import { CAMERA_BUBBLE_LIMITS, cameraBubbleScale, type CameraLayout, type Project } from '@/types';
import { useEditor, useEditorState } from '../../state/EditorContext';
import { FieldRow, SliderField } from '../fields';
import { ChoiceGrid, ColorField, PanelSection, percent } from './common';

const ASPECTS = [
  { value: '1', label: 'Square' },
  { value: '1.3333', label: '4:3' },
  { value: '1.7778', label: '16:9' },
  { value: '0.75', label: 'Portrait' },
] as const;

const POSITIONS: ReadonlyArray<{ value: string; label: string; x: number; y: number }> = [
  { value: 'tl', label: 'Top left', x: 0, y: 0 },
  { value: 'tr', label: 'Top right', x: 1, y: 0 },
  { value: 'bl', label: 'Bottom left', x: 0, y: 1 },
  { value: 'br', label: 'Bottom right', x: 1, y: 1 },
];

/**
 * The camera bubble (Module 08): shape, size, position, border, shadow and a coloured ring. While
 * this panel is open the bubble can also be dragged and resized in the preview. Saved with the
 * project and used by the preview and the export.
 */
export function CameraPanel() {
  const { store, recording } = useEditor();
  const project = useEditorState((snapshot) => snapshot.project);
  const layout = project.cameraLayout;
  const hasCamera = project.timeline.tracks.some((track) => track.kind === 'camera' && track.clips.length > 0);
  if (!layout || !hasCamera) {
    return <p className="p-3 text-xs text-fg-muted">This recording has no camera. Turn on the camera in the studio before recording to get a camera bubble.</p>;
  }
  const style = cameraStyleOf(layout);
  const width = cameraBubbleScale(layout);
  const set = (patch: Partial<CameraLayout>, mergeKey?: string) =>
    store.edit('Change camera', (p: Project) => ({ ...p, cameraLayout: { ...p.cameraLayout!, ...patch } }), { mergeKey });
  // Corners: a small margin from the frame's edges (the bubble's height in frame-height units).
  const frameAspect = aspectValue(project.aspectRatio, { width: recording.width ?? 1920, height: recording.height ?? 1080 }, project.customSize);
  const place = (x: number, y: number) => {
    const margin = 0.03;
    const height = (width * frameAspect) / style.aspect;
    set({ x: x === 0 ? margin + width / 2 : 1 - margin - width / 2, y: y === 0 ? margin * frameAspect + height / 2 : 1 - margin * frameAspect - height / 2 });
  };

  return (
    <div data-testid="camera-panel">
      <PanelSection title="Position & size">
        <ChoiceGrid label="Place" options={POSITIONS} value={'' as string} onChange={(value) => { const position = POSITIONS.find((p) => p.value === value)!; place(position.x, position.y); }} columns={2} />
        <SliderField
          label="Size"
          value={width}
          min={CAMERA_BUBBLE_LIMITS.min}
          max={CAMERA_BUBBLE_LIMITS.max}
          step={0.005}
          display={percent}
          onChange={(scale) => set({ scale }, 'camera-size')}
        />
        <p className="text-[11px] text-fg-subtle">Or drag the bubble in the preview, and its corner to resize it. It always stays inside the frame.</p>
      </PanelSection>

      <PanelSection title="Shape">
        <FieldRow label="Shape">
          <SegmentedControl
            label="Shape"
            options={[
              { value: 'circle', label: 'Circle' },
              { value: 'rounded', label: 'Rounded' },
            ]}
            value={style.shape}
            onChange={(shape) => set({ shape })}
          />
        </FieldRow>
        {style.shape === 'rounded' && (
          <>
            <ChoiceGrid label="Proportions" options={ASPECTS} value={(ASPECTS.find((a) => Math.abs(Number(a.value) - style.aspect) < 0.01)?.value ?? '1') as (typeof ASPECTS)[number]['value']} onChange={(value) => set({ aspect: Number(value) })} columns={4} />
            <SliderField label="Corners" value={style.radius} min={0} max={0.5} step={0.01} display={percent} onChange={(radius) => set({ radius }, 'camera-radius')} />
          </>
        )}
      </PanelSection>

      <PanelSection
        title="Style"
        actions={
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => set({ shape: undefined, aspect: undefined, radius: undefined, borderWidth: undefined, borderColor: undefined, shadow: undefined, background: undefined, padding: undefined })}>
            Reset
          </Button>
        }
      >
        <SliderField label="Border" value={style.borderWidth} min={0} max={0.1} step={0.002} display={percent} onChange={(borderWidth) => set({ borderWidth }, 'camera-border')} />
        {style.borderWidth > 0 && <ColorField label="Border colour" value={style.borderColor} onChange={(borderColor) => set({ borderColor }, 'camera-border-color')} />}
        <SliderField label="Shadow" value={style.shadow} min={0} max={1} step={0.05} display={percent} onChange={(shadow) => set({ shadow }, 'camera-shadow')} />
        <Toggle label="Background ring" description="A coloured ring around the camera picture" checked={style.background !== null} onCheckedChange={(on) => set({ background: on ? '#7c5cff' : null, padding: on ? Math.max(style.padding, 0.04) : style.padding })} />
        {style.background !== null && (
          <>
            <ColorField label="Ring colour" value={style.background} onChange={(background) => set({ background }, 'camera-bg')} />
            <SliderField label="Ring width" value={style.padding} min={0} max={0.15} step={0.005} display={percent} onChange={(padding) => set({ padding }, 'camera-padding')} />
          </>
        )}
      </PanelSection>
    </div>
  );
}
