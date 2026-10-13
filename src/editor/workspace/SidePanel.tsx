import { useState } from 'react';
import { Film, MousePointer2, PanelLeftClose, SlidersHorizontal, Type, ZoomIn, type LucideIcon } from 'lucide-react';
import { timelineScene } from '@/services/render/compose';
import { attachMarkers } from '@/services/timeline/attachment';
import { clipsOfAsset } from '@/services/timeline/mapping';
import { clipEnd } from '@/services/timeline/model';
import { regenerateAutoMarkers, updateMarker } from '@/services/zoom/markers';
import { Button, ConfirmDialog, IconButton } from '@/shared/components';
import type { TextClip, ZoomMarker } from '@/types';
import { cn } from '@/utils/cn';
import { ZoomEffectsPanel } from '../components/ZoomEffectsPanel';
import { formatTimecode, useEditor, useEditorState } from '../state/EditorContext';
import { MediaLibrary } from './MediaLibrary';
import { CursorSettings, PropertiesContent } from './PropertiesPanel';
import { useTimelineActions } from './useTimelineActions';

export type SideTab = 'media' | 'text' | 'zoom' | 'cursor' | 'edit';

export const SIDE_TABS: ReadonlyArray<{ value: SideTab; label: string; title: string; icon: LucideIcon }> = [
  { value: 'media', label: 'Media', title: 'Media library', icon: Film },
  { value: 'text', label: 'Text', title: 'Text', icon: Type },
  { value: 'zoom', label: 'Zoom', title: 'Zoom effects', icon: ZoomIn },
  { value: 'cursor', label: 'Cursor', title: 'Cursor & clicks', icon: MousePointer2 },
  { value: 'edit', label: 'Edit', title: 'Properties', icon: SlidersHorizontal },
];

/** The vertical icon rail on the left edge: picks the side panel, or hides it when picked again. */
export function SideRail({ tab, open, onPick }: { tab: SideTab; open: boolean; onPick: (tab: SideTab) => void }) {
  const selectionCount = useEditorState((snapshot) => snapshot.selection.length);
  return (
    <nav aria-label="Editor panels" className="flex w-14 shrink-0 flex-col items-center overflow-y-auto border-r border-line bg-surface py-2">
      <div role="tablist" aria-orientation="vertical" aria-label="Panels" className="flex flex-col gap-1">
        {SIDE_TABS.map((item) => {
          const active = open && tab === item.value;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={active ? 'side-panel' : undefined}
              title={item.title}
              onClick={() => onPick(item.value)}
              className={cn(
                'relative flex w-12 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10px] transition-colors',
                active ? 'bg-surface-3 text-fg' : 'text-fg-subtle hover:bg-surface-2 hover:text-fg',
              )}
            >
              <item.icon size={17} aria-hidden />
              <span className="[@media(max-height:640px)]:sr-only">{item.label}</span>
              {item.value === 'edit' && selectionCount > 0 && <span aria-hidden className="absolute top-1 right-2.5 size-1.5 rounded-full bg-warning" />}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** The panel next to the rail, showing the chosen tab. */
export function SidePanel({
  tab,
  onClose,
  keepTab,
  className,
}: {
  tab: SideTab;
  onClose: () => void;
  /** Call before a list action that selects items, to stay on this panel. */
  keepTab: () => void;
  className?: string;
}) {
  const info = SIDE_TABS.find((item) => item.value === tab)!;
  return (
    <aside
      id="side-panel"
      role="tabpanel"
      aria-label={info.title}
      className={cn('flex min-h-0 flex-col border-r border-line bg-surface', className)}
      data-testid={tab === 'edit' ? 'properties' : undefined}
    >
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-line pr-1.5 pl-4">
        <h2 className="text-sm font-semibold">{info.title}</h2>
        <IconButton icon={PanelLeftClose} label="Hide panel" size="sm" tooltipAlign="end" onClick={onClose} />
      </header>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {tab === 'media' && <MediaLibrary />}
        {tab === 'text' && <TextTab />}
        {tab === 'zoom' && <ZoomTab keepTab={keepTab} />}
        {tab === 'cursor' && <CursorSettings />}
        {tab === 'edit' && <PropertiesContent />}
      </div>
    </aside>
  );
}

function TextTab() {
  const { store, player } = useEditor();
  const actions = useTimelineActions();
  const timeline = useEditorState((snapshot) => snapshot.project.timeline);
  const selection = useEditorState((snapshot) => snapshot.selection);
  const texts = timeline.tracks.flatMap((track) => track.clips.filter((clip): clip is TextClip => clip.type === 'text'));
  return (
    <div className="space-y-3 p-3">
      <Button size="sm" icon={Type} onClick={() => actions.addText()}>
        Add text at playhead
      </Button>
      <p className="text-xs text-fg-subtle">Titles and captions drawn over the video. Select one to edit its words, size and colour, or drag it in the preview.</p>
      {texts.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-4 text-center text-xs text-fg-subtle">No text yet. Press T to add one at the playhead.</p>
      ) : (
        <ul className="space-y-1" aria-label="Texts on the timeline">
          {texts.map((clip) => (
            <li key={clip.id}>
              <button
                type="button"
                onClick={() => {
                  store.select([clip.id]);
                  player?.seek(clip.startMs);
                }}
                className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left', selection.includes(clip.id) ? 'bg-accent-soft' : 'hover:bg-surface-2')}
              >
                <Type size={13} aria-hidden className="shrink-0 text-accent-2" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{clip.text || 'Empty text'}</span>
                <span className="font-mono text-[11px] text-fg-subtle">{formatTimecode(clip.startMs)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ZoomTab({ keepTab }: { keepTab: () => void }) {
  const { store, recording, player } = useEditor();
  const project = useEditorState((snapshot) => snapshot.project);
  const selection = useEditorState((snapshot) => snapshot.selection);
  const actions = useTimelineActions();
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const markers = project.timeline.zoomMarkers;

  const select = (marker: ZoomMarker) => {
    store.select([marker.id]);
    player?.seek(marker.timeMs);
  };

  return (
    <div className="space-y-4 p-3">
      <ZoomEffectsPanel
        markers={markers}
        clicks={recording.interactions.length}
        clickTracking={recording.clickTracking}
        selectedId={selection.length === 1 ? selection[0]! : null}
        busy={false}
        onAdd={() => {
          keepTab();
          actions.addZoomEffect();
        }}
        onEdit={select}
        onDuplicate={(marker) => {
          keepTab();
          store.select([marker.id]);
          actions.duplicateSelection();
        }}
        onDelete={(marker) => {
          keepTab();
          store.select([marker.id]);
          actions.deleteSelection();
        }}
        onToggle={(marker, enabled) =>
          store.edit(enabled ? 'Enable effect' : 'Disable effect', (p) => ({
            ...p,
            timeline: { ...p.timeline, zoomMarkers: updateMarker(p.timeline.zoomMarkers, marker.id, { enabled }, p.timeline.durationMs) },
          }))
        }
        onRegenerate={() => setConfirmRegenerate(true)}
      />
      <ConfirmDialog
        open={confirmRegenerate}
        onClose={() => setConfirmRegenerate(false)}
        onConfirm={() => {
          store.edit('Generate zoom effects', (p) => {
            // Clicks are placed where their moment now plays on the edited timeline.
            const clicks = timelineScene(p, recording).clicks;
            const markers = regenerateAutoMarkers(p.timeline.zoomMarkers, [...clicks], p.zoom, p.timeline.durationMs);
            // Effects made from clicks zoom into the screen recording: they belong to its clip there.
            const screenClips = clipsOfAsset(p.timeline, recording.screenAssetId);
            const zoomMarkers = attachMarkers(p.timeline, markers, (marker) => screenClips.find((clip) => marker.timeMs >= clip.startMs && marker.timeMs < clipEnd(clip))?.id);
            return { ...p, timeline: { ...p.timeline, zoomMarkers } };
          });
        }}
        title="Generate zoom effects from clicks?"
        description={`Automatic effects are recreated from the ${recording.interactions.length} tracked clicks, placed where they now play on the timeline. Effects you added or edited are kept.`}
        confirmLabel="Generate effects"
      />
      <p className="text-[11px] text-fg-subtle">Select an effect to edit its zoom level, focus, hold and transition. Effects can also be dragged on the timeline.</p>
    </div>
  );
}
