import { useEffect, useRef } from 'react';
import { FileUp, Image as ImageIcon } from 'lucide-react';
import { BACKGROUND_PRESETS } from '@/services/render/backgrounds';
import { backgroundOf, clampCustomSize, FRAME_LAYOUT_PRESETS, frameLayoutOf, LIMITS } from '@/services/render/enhancements';
import { Button } from '@/shared/components';
import type { AspectRatio, BackgroundStyle, FrameLayout, Project } from '@/types';
import { cn } from '@/utils/cn';
import { useEditor, useEditorState } from '../../state/EditorContext';
import { NumberField, SliderField } from '../fields';
import { useImportFiles } from '../useImportFiles';
import { useThumbnail } from '../useThumbnail';
import { ChoiceGrid, ColorField, PanelSection, percent } from './common';

const ASPECTS: ReadonlyArray<{ value: AspectRatio; label: string }> = [
  { value: 'source', label: 'Original' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: 'custom', label: 'Custom' },
];

const CUSTOM_PRESETS = [
  { label: '1080×1350 (portrait post)', width: 1080, height: 1350 },
  { label: '1200×628 (link preview)', width: 1200, height: 628 },
  { label: '2560×1080 (ultrawide)', width: 2560, height: 1080 },
];

const KINDS: ReadonlyArray<{ value: BackgroundStyle['kind']; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'color', label: 'Colour' },
  { value: 'gradient', label: 'Gradient' },
  { value: 'preset', label: 'Presets' },
  { value: 'image', label: 'Image' },
];

const FITS: ReadonlyArray<{ value: BackgroundStyle['fit']; label: string }> = [
  { value: 'cover', label: 'Fill' },
  { value: 'contain', label: 'Fit' },
  { value: 'stretch', label: 'Stretch' },
  { value: 'tile', label: 'Tile' },
];

/**
 * Background & layout (Module 08): the output's shape (aspect ratio or custom size), what is behind
 * the recording, and how the recording sits on it (padding, rounded corners, shadow).
 */
export function BackgroundPanel() {
  const { store, recording } = useEditor();
  const project = useEditorState((snapshot) => snapshot.project);
  const background = backgroundOf(project);
  const layout = frameLayoutOf(project);
  const custom = project.customSize ?? { width: recording.width ?? 1920, height: recording.height ?? 1080 };

  const edit = (label: string, change: (p: Project) => Project, mergeKey?: string) => store.edit(label, change, { mergeKey });
  const setBackground = (patch: Partial<BackgroundStyle>, mergeKey?: string) =>
    edit('Change background', (p) => ({ ...p, background: { ...backgroundOf(p), ...patch } }), mergeKey);
  const setLayout = (patch: Partial<FrameLayout>, mergeKey?: string) => edit('Change layout', (p) => ({ ...p, frameLayout: { ...frameLayoutOf(p), ...patch } }), mergeKey);
  const setAspect = (aspectRatio: AspectRatio) =>
    edit('Change aspect ratio', (p) => ({ ...p, aspectRatio, customSize: aspectRatio === 'custom' ? clampCustomSize(p.customSize ?? custom) : p.customSize }));
  const setCustom = (size: { width: number; height: number }) => edit('Change size', (p) => ({ ...p, aspectRatio: 'custom', customSize: clampCustomSize(size) }));
  const hidden = background.kind !== 'none' && layout.padding === 0 && project.aspectRatio === 'source';

  return (
    <div data-testid="background-panel">
      <PanelSection title="Canvas">
        <ChoiceGrid label="Aspect ratio" options={ASPECTS} value={project.aspectRatio} onChange={setAspect} />
        {project.aspectRatio === 'custom' && (
          <div className="space-y-2">
            <NumberField label="Width (px)" value={custom.width} min={LIMITS.customSide.min} max={LIMITS.customSide.max} decimals={0} onCommit={(width) => setCustom({ ...custom, width })} />
            <NumberField label="Height (px)" value={custom.height} min={LIMITS.customSide.min} max={LIMITS.customSide.max} decimals={0} onCommit={(height) => setCustom({ ...custom, height })} />
            <div className="flex flex-wrap gap-1">
              {CUSTOM_PRESETS.map((preset) => (
                <button key={preset.label} type="button" className="rounded-md bg-surface-2 px-2 py-1 text-[11px] text-fg-muted hover:text-fg" onClick={() => setCustom(preset)}>
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <p className="text-[11px] text-fg-subtle">Zoom, cropping, captions and overlays keep their places: the recording is fitted inside the new shape.</p>
      </PanelSection>

      <PanelSection title="Background">
        <ChoiceGrid label="Background" options={KINDS} value={background.kind} onChange={(kind) => setBackground({ kind })} />
        {background.kind === 'color' && <ColorField label="Colour" value={background.color} onChange={(color) => setBackground({ color }, 'bg-color')} />}
        {background.kind === 'gradient' && (
          <>
            <ColorField label="From" value={background.gradient.from} onChange={(from) => setBackground({ gradient: { ...background.gradient, from } }, 'bg-from')} />
            <ColorField label="To" value={background.gradient.to} onChange={(to) => setBackground({ gradient: { ...background.gradient, to } }, 'bg-to')} />
            <SliderField
              label="Angle"
              value={background.gradient.angle}
              min={0}
              max={360}
              step={5}
              display={(value) => `${value}°`}
              onChange={(angle) => setBackground({ gradient: { ...background.gradient, angle } }, 'bg-angle')}
            />
          </>
        )}
        {background.kind === 'preset' && (
          <div role="radiogroup" aria-label="Background presets" className="grid grid-cols-3 gap-1.5">
            {BACKGROUND_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={background.presetId === preset.id}
                aria-label={preset.label}
                title={preset.label}
                onClick={() => setBackground({ presetId: preset.id })}
                className={cn('overflow-hidden rounded-lg border-2', background.presetId === preset.id ? 'border-accent' : 'border-transparent hover:border-line-strong')}
              >
                <PresetSwatch id={preset.id} />
                <span className="block bg-surface-2 py-0.5 text-[10px] text-fg-muted">{preset.label}</span>
              </button>
            ))}
          </div>
        )}
        {background.kind === 'image' && <ImageBackground background={background} onChange={setBackground} />}
        {hidden && <p className="rounded-lg bg-surface-2 p-2 text-[11px] text-fg-muted">The recording covers the whole frame: add space around it (Layout, below) or change the aspect ratio to see the background.</p>}
      </PanelSection>

      <PanelSection title="Layout">
        <div className="grid grid-cols-4 gap-1">
          {FRAME_LAYOUT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              aria-pressed={layout.padding === preset.layout.padding && layout.radius === preset.layout.radius && layout.shadow === preset.layout.shadow}
              onClick={() => edit('Change layout', (p) => ({ ...p, frameLayout: { ...preset.layout }, background: p.background ?? (preset.layout.padding > 0 ? { ...backgroundOf(p), kind: 'preset', presetId: 'aurora' } : undefined) }))}
              className="rounded-lg border border-line bg-surface-2 px-1 py-1.5 text-xs text-fg-muted hover:text-fg aria-pressed:border-accent aria-pressed:text-fg"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <SliderField label="Padding" value={layout.padding} min={0} max={LIMITS.padding.max} step={0.01} display={percent} onChange={(padding) => setLayout({ padding }, 'layout-padding')} />
        <SliderField label="Corners" value={layout.radius} min={0} max={LIMITS.radius.max} step={0.005} display={percent} onChange={(radius) => setLayout({ radius }, 'layout-radius')} />
        <SliderField label="Shadow" value={layout.shadow} min={0} max={1} step={0.05} display={percent} onChange={(shadow) => setLayout({ shadow }, 'layout-shadow')} />
      </PanelSection>
    </div>
  );
}

/** A preset drawn by the same code as the preview and the export. */
function PresetSwatch({ id }: { id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) BACKGROUND_PRESETS.find((preset) => preset.id === id)?.draw(ctx, canvas.width, canvas.height);
  }, [id]);
  return <canvas ref={ref} width={96} height={54} className="block aspect-video w-full" aria-hidden />;
}

/** Background images: imported into the project, then chosen here; fit, focus and blur. */
function ImageBackground({ background, onChange }: { background: BackgroundStyle; onChange: (patch: Partial<BackgroundStyle>, mergeKey?: string) => void }) {
  const { assets } = useEditor();
  const { importFiles, importing } = useImportFiles();
  const input = useRef<HTMLInputElement>(null);
  const images = assets.filter((asset) => asset.kind === 'image');
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Background image">
        {images.map((asset) => (
          <ImageChoice key={asset.id} assetId={asset.id} selected={background.imageAssetId === asset.id} onSelect={() => onChange({ imageAssetId: asset.id })} />
        ))}
      </div>
      <Button size="sm" icon={FileUp} loading={importing} onClick={() => input.current?.click()}>
        Upload image
      </Button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid="background-upload"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          void importFiles(files).then((added) => added[0] && onChange({ imageAssetId: added[0].id }));
        }}
      />
      {!background.imageAssetId && <p className="text-[11px] text-fg-subtle">Upload an image, or pick one you imported. Until then the colour below is used.</p>}
      <ChoiceGrid label="Fit" options={FITS} value={background.fit} onChange={(fit) => onChange({ fit })} columns={4} />
      {background.fit !== 'tile' && background.fit !== 'stretch' && (
        <>
          <SliderField label="Across" value={background.position.x} min={0} max={1} step={0.01} display={percent} onChange={(x) => onChange({ position: { ...background.position, x } }, 'bg-x')} />
          <SliderField label="Down" value={background.position.y} min={0} max={1} step={0.01} display={percent} onChange={(y) => onChange({ position: { ...background.position, y } }, 'bg-y')} />
        </>
      )}
      <SliderField label="Blur" value={background.blur} min={0} max={LIMITS.blur.max} step={0.002} display={(value) => `${Math.round((value / LIMITS.blur.max) * 100)} %`} onChange={(blur) => onChange({ blur }, 'bg-blur')} />
      <ColorField label="Colour" value={background.color} onChange={(color) => onChange({ color }, 'bg-color')} />
    </div>
  );
}

function ImageChoice({ assetId, selected, onSelect }: { assetId: string; selected: boolean; onSelect: () => void }) {
  const { assets } = useEditor();
  const asset = assets.find((candidate) => candidate.id === assetId);
  const thumbnail = useThumbnail(asset);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={asset?.label ?? 'Image'}
      title={asset?.label}
      onClick={onSelect}
      className={cn('flex aspect-video items-center justify-center overflow-hidden rounded-lg border-2 bg-surface-3', selected ? 'border-accent' : 'border-transparent hover:border-line-strong')}
    >
      {thumbnail ? <img src={thumbnail} alt="" className="h-full w-full object-cover" /> : <ImageIcon size={16} aria-hidden className="text-fg-subtle" />}
    </button>
  );
}
