import { useRef, useState } from 'react';
import {
  AudioLines,
  Download,
  FileUp,
  Film,
  Image,
  Loader2,
  Monitor,
  MousePointer2,
  PanelLeftClose,
  Plus,
  SlidersHorizontal,
  Trash2,
  Type,
  Video,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react';
import { downloadBlob } from '@/services/export/download';
import { assetFileName } from '@/services/export/exporters';
import { probeMedia } from '@/services/media/probe';
import { timelineScene } from '@/services/render/compose';
import { getAssetBlob } from '@/services/storage/assetRepository';
import { IMPORTABLE_TYPES, importProjectAsset, removeImportedAsset } from '@/services/storage/projectRepository';
import { trackKindsFor } from '@/services/timeline/model';
import { regenerateAutoMarkers, updateMarker } from '@/services/zoom/markers';
import { Button, ConfirmDialog, IconButton, useToast } from '@/shared/components';
import type { MediaAsset, MediaAssetKind, TextClip, ZoomMarker } from '@/types';
import { cn } from '@/utils/cn';
import { getErrorMessage } from '@/utils/errors';
import { formatBytes, formatDuration } from '@/utils/format';
import { describeStorageError, isQuotaError } from '@/utils/storageErrors';
import { ZoomEffectsPanel } from '../components/ZoomEffectsPanel';
import { formatTimecode, useEditor, useEditorState } from '../state/EditorContext';
import { CursorSettings, PropertiesContent } from './PropertiesPanel';
import { useTimelineActions } from './useTimelineActions';

const ASSET_INFO: Partial<Record<MediaAssetKind, { label: string; icon: LucideIcon }>> = {
  screen: { label: 'Screen recording', icon: Monitor },
  camera: { label: 'Camera', icon: Video },
  microphone: { label: 'Microphone', icon: AudioLines },
  'system-audio': { label: 'Tab / system audio', icon: AudioLines },
  image: { label: 'Image', icon: Image },
  audio: { label: 'Audio', icon: AudioLines },
  video: { label: 'Video', icon: Film },
};

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
  onAssetsChanged,
  keepTab,
  className,
}: {
  tab: SideTab;
  onClose: () => void;
  onAssetsChanged: (assets: MediaAsset[]) => void;
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
        {tab === 'media' && <MediaTab onAssetsChanged={onAssetsChanged} />}
        {tab === 'text' && <TextTab />}
        {tab === 'zoom' && <ZoomTab keepTab={keepTab} />}
        {tab === 'cursor' && <CursorSettings />}
        {tab === 'edit' && <PropertiesContent />}
      </div>
    </aside>
  );
}

function MediaTab({ onAssetsChanged }: { onAssetsChanged: (assets: MediaAsset[]) => void }) {
  const { store, recording, assets, reportError } = useEditor();
  const toast = useToast();
  const actions = useTimelineActions();
  const timeline = useEditorState((snapshot) => snapshot.project.timeline);
  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(0);
  const own = assets.filter((asset) => asset.origin === 'recording');
  const imported = assets.filter((asset) => asset.origin === 'import');
  const used = new Set(timeline.tracks.flatMap((track) => track.clips.flatMap((clip) => (clip.type === 'media' ? [clip.assetId] : []))));

  const importFiles = async (files: FileList | null) => {
    const list = [...(files ?? [])];
    if (list.length === 0) return;
    setImporting((count) => count + list.length);
    let added: MediaAsset[] = [];
    for (const file of list) {
      try {
        if (!IMPORTABLE_TYPES.test(file.type)) throw new Error('Only video, audio and image files can be imported.');
        const info = await probeMedia(file);
        const asset = await importProjectAsset(store.project.id, file, info);
        added = [...added, asset];
        toast.show({ variant: 'success', title: `Imported “${asset.label}”`, description: 'Add it to the timeline with +.' });
      } catch (error) {
        // A full disk gets the storage explanation; anything else (format, codec) its own message.
        const description = isQuotaError(error) ? describeStorageError(error) : getErrorMessage(error);
        toast.show({ variant: 'error', title: `Could not import “${file.name}”`, description });
      } finally {
        setImporting((count) => count - 1);
      }
    }
    if (added.length) onAssetsChanged([...assets, ...added]);
  };

  const remove = async (asset: MediaAsset) => {
    if (used.has(asset.id)) return reportError('This file is used on the timeline. Delete its clips first.');
    try {
      await store.flush();
      await removeImportedAsset(store.project.id, asset.id);
      onAssetsChanged(assets.filter((candidate) => candidate.id !== asset.id));
      toast.show({ title: `Removed “${asset.label}” from the project` });
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
    }
  };

  const download = async (asset: MediaAsset) => {
    const blob = await getAssetBlob(asset.id).catch(() => undefined);
    if (!blob) return reportError('This file is missing from local storage.');
    downloadBlob(blob, assetFileName(recording, asset));
  };

  return (
    <div className="space-y-4 p-3">
      <section aria-labelledby="library-recording">
        <h3 id="library-recording" className="mb-2 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
          Recording
        </h3>
        <AssetList assets={own.filter((asset) => asset.kind !== 'thumbnail')} used={used} onAdd={(asset) => actions.addMedia(asset)} onDownload={download} />
      </section>

      <section aria-labelledby="library-imported">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 id="library-imported" className="text-xs font-semibold tracking-wide text-fg-subtle uppercase">
            Imported
          </h3>
          <Button size="sm" icon={importing ? Loader2 : FileUp} disabled={importing > 0} onClick={() => fileInput.current?.click()}>
            {importing ? 'Importing…' : 'Import'}
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="video/*,audio/*,image/*"
            className="hidden"
            data-testid="import-input"
            onChange={(event) => {
              void importFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </div>
        {imported.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line p-3 text-center text-xs text-fg-subtle">
            No imported files yet. Import video, music or images to place them on the timeline. Files stay on this device.
          </p>
        ) : (
          <AssetList assets={imported} used={used} onAdd={(asset) => actions.addMedia(asset)} onRemove={remove} onDownload={download} />
        )}
      </section>
    </div>
  );
}

function AssetList({
  assets,
  used,
  onAdd,
  onRemove,
  onDownload,
}: {
  assets: MediaAsset[];
  used: ReadonlySet<string>;
  onAdd: (asset: MediaAsset) => void;
  onRemove?: (asset: MediaAsset) => void;
  onDownload: (asset: MediaAsset) => void;
}) {
  return (
    <ul className="space-y-1.5" aria-label="Media files">
      {assets.map((asset) => {
        const info = ASSET_INFO[asset.kind];
        const Icon = info?.icon ?? Film;
        const name = asset.origin === 'import' ? (asset.label ?? info?.label ?? asset.kind) : (info?.label ?? asset.kind);
        const placeable = trackKindsFor(asset).length > 0;
        return (
          <li key={asset.id} className="flex items-center gap-2 rounded-xl bg-surface-2 p-2">
            <Icon size={15} aria-hidden className="shrink-0 text-fg-subtle" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium" title={name}>
                {name}
              </p>
              <p className="truncate text-[11px] text-fg-subtle">
                {asset.kind === 'image' ? `${asset.width ?? '?'}×${asset.height ?? '?'}` : formatDuration(asset.durationMs ?? 0)} · {formatBytes(asset.size)}
                {used.has(asset.id) && ' · on timeline'}
              </p>
            </div>
            {placeable && <IconButton icon={Plus} label={`Add ${name} at the playhead`} size="sm" className="size-7 shrink-0" onClick={() => onAdd(asset)} />}
            <IconButton icon={Download} label={`Download ${name}`} size="sm" className="size-7 shrink-0" tooltipAlign="end" onClick={() => onDownload(asset)} />
            {onRemove && (
              <IconButton
                icon={Trash2}
                label={used.has(asset.id) ? `${name} is used on the timeline` : `Remove ${name} from the project`}
                size="sm"
                tone="danger"
                tooltipAlign="end"
                className="size-7 shrink-0"
                disabled={used.has(asset.id)}
                onClick={() => onRemove(asset)}
              />
            )}
          </li>
        );
      })}
    </ul>
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
            return { ...p, timeline: { ...p.timeline, zoomMarkers: regenerateAutoMarkers(p.timeline.zoomMarkers, [...clicks], p.zoom, p.timeline.durationMs) } };
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
