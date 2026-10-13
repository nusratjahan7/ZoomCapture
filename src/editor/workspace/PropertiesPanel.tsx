import { useEffect, useId, useState, type ReactNode } from 'react';
import { Copy, Focus, MousePointer2, MousePointerClick, Scissors, Sparkles, Trash2, ZoomIn } from 'lucide-react';
import { renderEffectsOf } from '@/services/render/frameState';
import { describeMimeType } from '@/services/recording/mimeTypes';
import { clipDuration, findClip, isMediaClip } from '@/services/timeline/model';
import { setClipTiming, updateMediaClip, updateTextClip } from '@/services/timeline/operations';
import { updateMarker, type MarkerPatch } from '@/services/zoom/markers';
import { Button, SegmentedControl, Toggle } from '@/shared/components';
import {
  TRANSITION_MS,
  ZOOM_LIMITS,
  type MediaClip,
  type Project,
  type TextClip,
  type TextSize,
  type TimelineTrack,
  type TransitionSpeed,
  type ZoomMarker,
} from '@/types';
import { formatBytes, formatDuration } from '@/utils/format';
import { trackingSummary } from '../components/ZoomEffectsPanel';
import { formatTimecode, useEditor, useEditorState } from '../state/EditorContext';
import { FieldRow, NumberField, SliderField, TimeField } from './fields';
import { useTimelineActions } from './useTimelineActions';

function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="space-y-3 border-b border-line p-4 last:border-b-0">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

/** Properties of the selected item, or of the project when nothing is selected. */
export function PropertiesContent() {
  const project = useEditorState((snapshot) => snapshot.project);
  const selection = useEditorState((snapshot) => snapshot.selection);
  const actions = useTimelineActions();

  let body: ReactNode;
  if (selection.length > 1) {
    body = (
      <Section title={`${selection.length} items selected`}>
        <p className="text-xs text-fg-muted">Drag one of them, nudge with Alt + ←/→, or delete them together.</p>
        <Button size="sm" variant="danger" icon={Trash2} onClick={() => actions.deleteSelection()}>
          Delete {selection.length} items
        </Button>
      </Section>
    );
  } else if (selection.length === 1) {
    const id = selection[0]!;
    const marker = project.timeline.zoomMarkers.find((candidate) => candidate.id === id);
    const found = marker ? null : findClip(project.timeline, id);
    if (marker) body = <MarkerProperties marker={marker} />;
    else if (found && isMediaClip(found.clip)) body = <MediaClipProperties clip={found.clip} track={found.track} />;
    else if (found && found.clip.type === 'text') body = <TextProperties clip={found.clip} />;
  }

  return <>{body ?? <ProjectProperties project={project} />}</>;
}

function ItemActions({ onDuplicate, canSplit }: { onDuplicate?: boolean; canSplit?: boolean }) {
  const actions = useTimelineActions();
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {canSplit && (
        <Button size="sm" icon={Scissors} onClick={() => actions.split()}>
          Split at playhead
        </Button>
      )}
      {onDuplicate && (
        <Button size="sm" icon={Copy} onClick={() => actions.duplicateSelection()}>
          Duplicate
        </Button>
      )}
      <Button size="sm" variant="danger" icon={Trash2} onClick={() => actions.deleteSelection()}>
        Delete
      </Button>
    </div>
  );
}

function MediaClipProperties({ clip, track }: { clip: MediaClip; track: TimelineTrack }) {
  const { store, assets, assetLookup } = useEditor();
  const asset = assets.find((candidate) => candidate.id === clip.assetId);
  const audible = track.kind !== 'camera' && asset?.kind !== 'image' && asset?.hasAudio !== false;
  const edit = (label: string, change: (project: Project) => Project, mergeKey?: string) => store.edit(label, change, { mergeKey });
  return (
    <Section title={asset?.origin === 'import' ? (asset.label ?? 'Imported clip') : `${track.name} clip`}>
      {!asset && <p className="rounded-lg bg-danger/10 p-2 text-xs text-danger">This clip’s media is missing (its file was removed). Delete the clip or undo the removal.</p>}
      <TimeField label="Start" value={clip.startMs} onCommit={(startMs) => edit('Move clip', (p) => ({ ...p, timeline: setClipTiming(p.timeline, clip.id, { startMs }, assetLookup) }))} />
      <TimeField
        label="Duration"
        value={clipDuration(clip)}
        min={100}
        onCommit={(durationMs) => edit('Change duration', (p) => ({ ...p, timeline: setClipTiming(p.timeline, clip.id, { durationMs }, assetLookup) }))}
      />
      {asset?.kind !== 'image' && (
        <FieldRow label="Source">
          <span className="font-mono text-xs text-fg-muted" data-testid="clip-source">
            {formatTimecode(clip.sourceInMs)} – {formatTimecode(clip.sourceOutMs)}
            {asset?.durationMs ? ` of ${formatTimecode(asset.durationMs)}` : ''}
          </span>
        </FieldRow>
      )}
      {audible && (
        <>
          <SliderField
            label="Volume"
            value={clip.volume ?? 1}
            min={0}
            max={1}
            step={0.05}
            display={(value) => `${Math.round(value * 100)} %`}
            onChange={(volume) => edit('Change volume', (p) => ({ ...p, timeline: updateMediaClip(p.timeline, clip.id, { volume }) }), `volume:${clip.id}`)}
          />
          <Toggle
            label="Mute this clip"
            checked={Boolean(clip.muted)}
            onCheckedChange={(muted) => edit(muted ? 'Mute clip' : 'Unmute clip', (p) => ({ ...p, timeline: updateMediaClip(p.timeline, clip.id, { muted }) }))}
          />
        </>
      )}
      {asset && (
        <p className="text-[11px] text-fg-subtle">
          {describeMimeType(asset.mimeType)} · {formatBytes(asset.size)}
          {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}
        </p>
      )}
      <ItemActions canSplit onDuplicate />
    </Section>
  );
}

const TEXT_SIZES = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
] as const satisfies ReadonlyArray<{ value: TextSize; label: string }>;

function TextProperties({ clip }: { clip: TextClip }) {
  const { store, assetLookup } = useEditor();
  const textId = useId();
  const colorId = useId();
  const editText = (label: string, patch: Parameters<typeof updateTextClip>[2], mergeKey?: string) =>
    store.edit(label, (p) => ({ ...p, timeline: updateTextClip(p.timeline, clip.id, patch) }), { mergeKey });
  return (
    <Section title="Text">
      <div>
        <label htmlFor={textId} className="text-xs text-fg-muted">
          Text
        </label>
        <textarea
          id={textId}
          value={clip.text}
          rows={3}
          maxLength={300}
          onChange={(event) => editText('Edit text', { text: event.target.value }, `text:${clip.id}`)}
          className="mt-1 w-full resize-y rounded-lg border border-line-strong bg-surface-2 p-2 text-sm text-fg"
        />
        {!clip.text.trim() && <p className="text-[11px] text-warning">Empty text is not shown.</p>}
      </div>
      <FieldRow label="Size">
        <SegmentedControl label="Text size" options={TEXT_SIZES} value={clip.style.size} onChange={(size) => editText('Text size', { style: { size } })} />
      </FieldRow>
      <FieldRow label="Colour" htmlFor={colorId}>
        <input
          id={colorId}
          type="color"
          value={clip.style.color}
          onChange={(event) => editText('Text colour', { style: { color: event.target.value } }, `color:${clip.id}`)}
          className="h-8 w-16 cursor-pointer rounded border border-line-strong bg-surface-2"
        />
      </FieldRow>
      <Toggle label="Background box" description="Dark box behind the text" checked={clip.style.background} onCheckedChange={(background) => editText('Text background', { style: { background } })} />
      <NumberField label="Across" unit="%" value={clip.position.x * 100} min={0} max={100} decimals={0} onCommit={(x) => editText('Move text', { position: { ...clip.position, x: x / 100 } })} />
      <NumberField label="Down" unit="%" value={clip.position.y * 100} min={0} max={100} decimals={0} onCommit={(y) => editText('Move text', { position: { ...clip.position, y: y / 100 } })} />
      <p className="text-[11px] text-fg-subtle">Or drag the text box in the preview.</p>
      <TimeField label="Start" value={clip.startMs} onCommit={(startMs) => store.edit('Move text', (p) => ({ ...p, timeline: setClipTiming(p.timeline, clip.id, { startMs }, assetLookup) }))} />
      <TimeField
        label="Duration"
        value={clip.durationMs}
        min={100}
        onCommit={(durationMs) => store.edit('Change duration', (p) => ({ ...p, timeline: setClipTiming(p.timeline, clip.id, { durationMs }, assetLookup) }))}
      />
      <ItemActions canSplit onDuplicate />
    </Section>
  );
}

const TRANSITIONS = [
  { value: 'slow', label: 'Slow' },
  { value: 'normal', label: 'Normal' },
  { value: 'fast', label: 'Fast' },
] as const satisfies ReadonlyArray<{ value: TransitionSpeed; label: string }>;

const speedOf = (transitionMs: number): TransitionSpeed | null =>
  (Object.entries(TRANSITION_MS) as Array<[TransitionSpeed, number]>).find(([, ms]) => ms === transitionMs)?.[0] ?? null;

function MarkerProperties({ marker }: { marker: ZoomMarker }) {
  const { store } = useEditor();
  const annotationId = useId();
  const change = (label: string, patch: MarkerPatch, mergeKey?: string) =>
    store.edit(
      label,
      (p) => ({ ...p, timeline: { ...p.timeline, zoomMarkers: updateMarker(p.timeline.zoomMarkers, marker.id, patch, p.timeline.durationMs) } }),
      { mergeKey },
    );
  const speed = speedOf(marker.transitionMs);
  return (
    <Section title={marker.effect === 'zoom' ? 'Zoom effect' : 'Highlight effect'}>
      <FieldRow label="Effect">
        <SegmentedControl
          label="Effect"
          options={[
            { value: 'zoom', label: 'Zoom', icon: ZoomIn },
            { value: 'highlight', label: 'Highlight', icon: Sparkles },
          ]}
          value={marker.effect}
          onChange={(effect) => change('Change effect', { effect })}
        />
      </FieldRow>
      <SliderField
        label="Zoom level"
        value={marker.scale}
        min={ZOOM_LIMITS.scale.min}
        max={ZOOM_LIMITS.scale.max}
        step={0.1}
        disabled={marker.effect !== 'zoom'}
        display={(value) => `${value.toFixed(1)}×`}
        onChange={(scale) => change('Change zoom level', { scale }, `scale:${marker.id}`)}
      />
      <NumberField label="Position across" unit="%" value={marker.position.x * 100} min={0} max={100} decimals={0} onCommit={(x) => change('Move zoom focus', { position: { ...marker.position, x: x / 100 } })} />
      <NumberField label="Position down" unit="%" value={marker.position.y * 100} min={0} max={100} decimals={0} onCommit={(y) => change('Move zoom focus', { position: { ...marker.position, y: y / 100 } })} />
      <p className="text-[11px] text-fg-subtle">Or click “Framing” under the preview and drag the focus point.</p>
      <TimeField label="Fully zoomed at" value={marker.timeMs} onCommit={(timeMs) => change('Move zoom effect', { timeMs })} />
      <NumberField
        label="Hold"
        unit="s"
        value={marker.durationMs}
        scale={1000}
        min={ZOOM_LIMITS.durationMs.min}
        max={ZOOM_LIMITS.durationMs.max}
        onCommit={(durationMs) => change('Change zoom duration', { durationMs })}
      />
      <FieldRow label="Transition">
        <SegmentedControl
          label="Transition speed"
          options={TRANSITIONS}
          value={speed ?? ('custom' as TransitionSpeed)}
          onChange={(value) => change('Change transition speed', { transitionMs: TRANSITION_MS[value] })}
        />
      </FieldRow>
      <NumberField
        label="Transition"
        unit="s"
        value={marker.transitionMs}
        scale={1000}
        decimals={2}
        min={ZOOM_LIMITS.transitionMs.min}
        max={ZOOM_LIMITS.transitionMs.max}
        onCommit={(transitionMs) => change('Change transition speed', { transitionMs })}
      />
      <FieldRow label="Position mode">
        <SegmentedControl
          label="Position mode"
          options={[
            { value: 'fixed', label: 'Fixed', icon: Focus },
            { value: 'follow-cursor', label: 'Follow cursor', icon: MousePointer2 },
          ]}
          value={marker.positionMode}
          onChange={(positionMode) => change('Change position mode', { positionMode })}
        />
      </FieldRow>
      <div>
        <label htmlFor={annotationId} className="text-xs text-fg-muted">
          Caption (optional)
        </label>
        <CaptionInput
          id={annotationId}
          marker={marker}
          onChange={(annotation) => change('Edit caption', { annotation }, `annotation:${marker.id}`)}
        />
      </div>
      <Toggle label="Enabled" description="Disabled effects are kept but not applied" checked={marker.enabled} onCheckedChange={(enabled) => change(enabled ? 'Enable effect' : 'Disable effect', { enabled })} />
      <ItemActions onDuplicate />
    </Section>
  );
}

const normalizeCaption = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The caption as typed: the stored caption is normalised (spaces collapsed and trimmed), so the
 * field keeps its own draft while typing and follows the stored value after undo or a new effect.
 */
function CaptionInput({ id, marker, onChange }: { id: string; marker: ZoomMarker; onChange: (annotation: string) => void }) {
  const stored = marker.annotation ?? '';
  const [draft, setDraft] = useState(stored);
  useEffect(() => {
    setDraft((current) => (normalizeCaption(current) === stored ? current : stored));
  }, [stored, marker.id]);
  return (
    <input
      id={id}
      value={draft}
      maxLength={200}
      placeholder="e.g. Click “Publish”"
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(event.target.value);
      }}
      className="mt-1 h-8 w-full rounded-lg border border-line-strong bg-surface-2 px-2 text-sm text-fg"
    />
  );
}

function ProjectProperties({ project }: { project: Project }) {
  const { recording } = useEditor();
  const clicks = recording.interactions.length;
  const facts: Array<[string, string]> = [
    ['Length', formatDuration(project.timeline.durationMs)],
    ['Tracks', String(project.timeline.tracks.length)],
    ['Zoom effects', String(project.timeline.zoomMarkers.length)],
    ['Recorded', new Date(recording.createdAt).toLocaleString()],
    ['Resolution', recording.width && recording.height ? `${recording.width}×${recording.height}` : '—'],
    ['Click tracking', recording.clickTracking.mode !== 'unsupported' ? `${clicks} clicks` : 'Not available'],
  ];
  return (
    <Section title="Project">
      <p className="text-xs text-fg-muted">Select a clip, text or zoom effect on the timeline to edit it here.</p>
      <dl className="space-y-1.5 text-xs">
        {facts.map(([term, value]) => (
          <div key={term} className="flex justify-between gap-3">
            <dt className="text-fg-subtle">{term}</dt>
            <dd className="truncate text-right">{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

/** Cursor and click overlays, with what click tracking captured for this recording. */
export function CursorSettings() {
  const { store, recording } = useEditor();
  const project = useEditorState((snapshot) => snapshot.project);
  const effects = renderEffectsOf(project);
  const cursorSamples = recording.cursor?.length ?? 0;
  const clicks = recording.interactions.length;
  const setEffects = (patch: Partial<typeof effects>) =>
    store.edit('Change overlays', (p) => ({ ...p, renderEffects: { ...renderEffectsOf(p), ...patch } }));
  return (
    <>
      <Section title="Tracking">
        <p className="flex items-start gap-2 text-xs text-fg-muted">
          <MousePointerClick size={14} aria-hidden className="mt-0.5 shrink-0" />
          <span>
            {trackingSummary(recording.clickTracking, clicks)}
            {cursorSamples > 0 ? ', with the pointer path.' : '.'} {recording.clickTracking.reason}
          </span>
        </p>
      </Section>
      <Section title="Cursor & clicks">
        <Toggle
          icon={MousePointerClick}
          label="Click emphasis"
          description={clicks > 0 ? 'A ring where each tracked click happened' : 'No clicks were tracked for this recording'}
          checked={effects.clickEmphasis && clicks > 0}
          disabled={clicks === 0}
          onCheckedChange={(clickEmphasis) => setEffects({ clickEmphasis })}
        />
        <Toggle
          icon={MousePointer2}
          label="Cursor highlight"
          description={cursorSamples > 0 ? 'A soft halo follows the pointer' : 'Pointer movement was not tracked for this recording'}
          checked={effects.cursorHighlight && cursorSamples > 0}
          disabled={cursorSamples === 0}
          onCheckedChange={(cursorHighlight) => setEffects({ cursorHighlight })}
        />
      </Section>
    </>
  );
}
