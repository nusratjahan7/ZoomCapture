import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, Clapperboard, CloudOff, Download, Keyboard, Loader2, PencilLine, Redo2, Settings, Trash2, Undo2 } from 'lucide-react';
import { sendMessage } from '@/services/messaging';
import type { TimelinePlayer } from '@/services/render/TimelinePlayer';
import { notifyLibraryChanged, subscribeLibrary } from '@/services/storage/libraryEvents';
import { saveProjectEdits } from '@/services/storage/projectRepository';
import type { RecordingDetails } from '@/services/storage/recordingRepository';
import type { AssetLookup } from '@/services/timeline/operations';
import { Button, Dialog, IconButton, LogoMark, useToast } from '@/shared/components';
import { useRecordingActions } from '@/shared/hooks/useRecordingActions';
import type { AspectRatio, MediaAsset } from '@/types';
import { createId } from '@/utils/id';
import { RenderVideoDialog } from '../components/RenderVideoDialog';
import { clampCustomSize } from '@/services/render/enhancements';
import { EditorContext, useEditor, useEditorState, type EditorContextValue } from '../state/EditorContext';
import { EditorStore } from '../state/EditorStore';
import { ControlBar } from './ControlBar';
import { PreviewPane, type PreviewOptions } from './PreviewPane';
import { SidePanel, SideRail, type SideTab } from './SidePanel';
import { timelineContentHeight, TimelinePanel } from './TimelinePanel';
import { useAssetUrls } from './useAssetUrls';
import { hasFiles, useImportFiles } from './useImportFiles';
import { SHORTCUTS, useEditorShortcuts } from './useEditorShortcuts';
import { useTimelineActions } from './useTimelineActions';

const ASPECTS: Array<{ value: AspectRatio; label: string }> = [
  { value: 'source', label: 'Original' },
  { value: '16:9', label: '16:9 Landscape' },
  { value: '9:16', label: '9:16 Portrait' },
  { value: '1:1', label: '1:1 Square' },
  { value: '4:3', label: '4:3' },
  { value: 'custom', label: 'Custom size…' },
];

/** Identifies this page in library change events (to recognise its own saves). */
const PAGE_ID = createId('pg');

/** Remembered per browser (a convenience; the editor works without it). */
const TIMELINE_HEIGHT_KEY = 'zoomcapture.editor.timelineHeight';
const TOOLBAR_HEIGHT = 48;
const CONTROL_BAR_HEIGHT = 46;
/** The preview never gets smaller than this when the timeline is resized. */
const MIN_PREVIEW_HEIGHT = 160;
const MIN_TIMELINE_HEIGHT = 120;
const WIDE_QUERY = '(min-width: 1024px)';

function readStoredHeight(): number | null {
  try {
    const value = Number(localStorage.getItem(TIMELINE_HEIGHT_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    list.addEventListener('change', onChange);
    onChange();
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/**
 * The video editor: an icon rail and side panel (media, text, zoom, cursor, properties) on the
 * left, the preview, a control bar, the timeline at the bottom and the toolbar on top. Owns the
 * EditorStore (undo/redo, autosave) for one project.
 */
export function EditorWorkspace({ details }: { details: RecordingDetails }) {
  const { recording } = details;
  const toast = useToast();
  const reportError = useCallback((message: string) => toast.show({ variant: 'error', title: 'Can’t do that', description: message }), [toast]);
  const [store] = useState(
    () =>
      new EditorStore(
        details.project,
        async (projectId, edits) => {
          await saveProjectEdits(projectId, edits);
          notifyLibraryChanged({ type: 'project', recordingId: recording.id, source: PAGE_ID });
        },
        reportError,
      ),
  );
  useEffect(() => () => store.dispose(), [store]);

  const [assets, setAssets] = useState<MediaAsset[]>(details.assets);
  const [player, setPlayer] = useState<TimelinePlayer | null>(null);
  const [snapping, setSnapping] = useState(true);
  const timelineZoom = useRef<(factor: number | 'fit') => void>(() => undefined);
  const urls = useAssetUrls(assets);
  const assetLookup = useMemo<AssetLookup>(() => {
    const map = new Map(assets.map((asset) => [asset.id, asset]));
    return (id) => map.get(id);
  }, [assets]);
  const playerRef = useRef(player);
  playerRef.current = player;
  const playheadMs = useCallback(() => playerRef.current?.time ?? 0, []);

  const addAssets = useCallback(
    (added: MediaAsset[]) => setAssets((current) => [...current, ...added.filter((asset) => !current.some((existing) => existing.id === asset.id))]),
    [],
  );
  const forgetAsset = useCallback((assetId: string) => setAssets((current) => current.filter((asset) => asset.id !== assetId)), []);
  const context = useMemo<EditorContextValue>(
    () => ({ store, player, setPlayer, recording, assets, assetLookup, addAssets, forgetAsset, reportError, playheadMs, snapping, setSnapping, timelineZoom }),
    [store, player, recording, assets, assetLookup, addAssets, forgetAsset, reportError, playheadMs, snapping],
  );

  // Never lose edits: save on leaving, and ask first while a save is pending or failed.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!store.hasUnsavedChanges) return;
      void store.flush();
      event.preventDefault();
    };
    const onHide = () => {
      if (store.hasUnsavedChanges) void store.flush();
    };
    const onVisibility = () => document.visibilityState === 'hidden' && onHide();
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [store]);

  // Another page saved this project: say so instead of silently overwriting either side.
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  useEffect(
    () =>
      subscribeLibrary((change) => {
        if (change.type === 'project' && change.recordingId === recording.id && change.source && change.source !== PAGE_ID) setChangedElsewhere(true);
      }),
    [recording.id],
  );

  useEffect(() => {
    document.title = `${recording.name} · ZoomCapture`;
  }, [recording.name]);

  return (
    <EditorContext.Provider value={context}>
      <div className="flex h-screen flex-col overflow-hidden">
        <Toolbar />
        {changedElsewhere && (
          <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
            <AlertTriangle size={16} aria-hidden />
            This project was changed in another tab. Saving here will replace those changes.
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setChangedElsewhere(false)}>
              Keep editing here
            </Button>
          </div>
        )}
        <EditorLayout urls={urls} />
      </div>
    </EditorContext.Provider>
  );
}

/**
 * Rail + side panel + preview on top, the control bar, then the resizable timeline. On narrow
 * windows the side panel floats over the preview instead of taking width from it.
 */
function EditorLayout({ urls }: { urls: ReturnType<typeof useAssetUrls> }) {
  const wide = useMediaQuery(WIDE_QUERY);
  const [side, setSide] = useState<{ tab: SideTab; open: boolean }>(() => ({ tab: 'media', open: window.matchMedia(WIDE_QUERY).matches }));
  const sideRef = useRef(side);
  sideRef.current = side;
  const previousTab = useRef<SideTab>('media');
  /** Set by side-panel list actions (duplicate, delete…) that select items but stay on the list. */
  const stayOnTab = useRef(false);
  const keepTab = useCallback(() => {
    stayOnTab.current = true;
    // Only for the change this action makes: cleared even if it selects nothing new.
    setTimeout(() => (stayOnTab.current = false), 0);
  }, []);
  const selection = useEditorState((snapshot) => snapshot.selection);
  const [options, setOptions] = useState<PreviewOptions>({ previewZoom: true, framing: false, clipFraming: false, speed: 1 });
  const changeOptions = useCallback((patch: Partial<PreviewOptions>) => setOptions((current) => ({ ...current, ...patch })), []);

  // Selecting something shows its properties; clearing the selection goes back to the last tab.
  const hasSelection = selection.length > 0;
  useEffect(() => {
    const current = sideRef.current;
    const stay = stayOnTab.current;
    stayOnTab.current = false;
    if (stay) return;
    if (hasSelection && current.tab !== 'edit') {
      previousTab.current = current.tab;
      setSide({ tab: 'edit', open: current.open || window.matchMedia(WIDE_QUERY).matches });
    } else if (!hasSelection && current.tab === 'edit') {
      setSide({ ...current, tab: previousTab.current });
    }
  }, [hasSelection, selection]);

  // Becoming narrow: the panel would cover the preview, so it closes (the rail reopens it).
  useEffect(() => {
    if (!wide) setSide((current) => (current.open ? { ...current, open: false } : current));
  }, [wide]);

  const pick = (tab: SideTab) => {
    if (tab !== 'edit') previousTab.current = tab;
    setSide((current) => (current.open && current.tab === tab ? { ...current, open: false } : { tab, open: true }));
  };

  // Timeline height: dragged with the handle above it, kept within the window.
  const [timelineHeight, setTimelineHeight] = useState(() => readStoredHeight() ?? Math.round(window.innerHeight * 0.32));
  const timeline = useEditorState((snapshot) => snapshot.project.timeline);
  // Never taller than its tracks: spare height goes to the preview.
  const hasCaptions = useEditorState((snapshot) => snapshot.project.subtitles.some((track) => track.cues.length > 0));
  const contentHeight = timelineContentHeight(timeline, hasCaptions);
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight);
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const maxTimeline = Math.max(MIN_TIMELINE_HEIGHT, viewportHeight - TOOLBAR_HEIGHT - CONTROL_BAR_HEIGHT - MIN_PREVIEW_HEIGHT);
  const height = Math.min(maxTimeline, contentHeight, Math.max(MIN_TIMELINE_HEIGHT, timelineHeight));
  const resize = (next: number) => {
    const clamped = Math.round(Math.min(maxTimeline, contentHeight, Math.max(MIN_TIMELINE_HEIGHT, next)));
    setTimelineHeight(clamped);
    try {
      localStorage.setItem(TIMELINE_HEIGHT_KEY, String(clamped));
    } catch {
      // Not remembered; the editor still works.
    }
  };
  const resizing = useRef<{ y: number; height: number } | null>(null);

  // Files dropped anywhere in the editor are imported (on the timeline they are also placed).
  const { importFiles } = useImportFiles();
  const [droppingFiles, setDroppingFiles] = useState(false);
  const dragDepth = useRef(0);

  return (
    <main
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(event) => {
        if (!hasFiles(event)) return;
        dragDepth.current += 1;
        setDroppingFiles(true);
      }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!hasFiles(event)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDroppingFiles(false);
      }}
      onDrop={(event) => {
        dragDepth.current = 0;
        setDroppingFiles(false);
        if (!hasFiles(event) || event.defaultPrevented) return;
        event.preventDefault();
        void importFiles([...event.dataTransfer.files]);
      }}
    >
      {droppingFiles && (
        <div aria-hidden className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-canvas/80 text-sm font-medium text-fg">
          Drop to import · drop on the timeline to place the files there
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <SideRail tab={side.tab} open={side.open} onPick={pick} />
        {side.open && (
          <SidePanel
            tab={side.tab}
            onClose={() => setSide((current) => ({ ...current, open: false }))}
            keepTab={keepTab}
            className={
              wide
                ? 'w-[clamp(260px,24vw,340px)] shrink-0'
                : 'absolute inset-y-0 left-14 z-30 w-[min(340px,calc(100vw-4rem))] shadow-[12px_0_40px_-12px_rgba(0,0,0,0.7)]'
            }
          />
        )}
        <div className="min-w-0 flex-1 bg-canvas">
          <PreviewPane urls={urls} options={options} onOptionsChange={changeOptions} cameraEditing={side.open && side.tab === 'camera'} />
        </div>
      </div>
      <ControlBar options={options} onOptionsChange={changeOptions} />
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the timeline"
        aria-valuemin={MIN_TIMELINE_HEIGHT}
        aria-valuemax={Math.min(maxTimeline, contentHeight)}
        aria-valuenow={height}
        tabIndex={0}
        className="group relative z-10 -my-1 h-2 shrink-0 cursor-row-resize touch-none outline-none"
        onPointerDown={(event) => {
          resizing.current = { y: event.clientY, height };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (resizing.current) resize(resizing.current.height - (event.clientY - resizing.current.y));
        }}
        onPointerUp={() => (resizing.current = null)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 80 : 20;
          if (event.key === 'ArrowUp') resize(height + step);
          else if (event.key === 'ArrowDown') resize(height - step);
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-transparent transition-colors group-hover:bg-accent/60 group-focus-visible:bg-accent-2" />
      </div>
      <div className="shrink-0" style={{ height }}>
        <TimelinePanel />
      </div>
    </main>
  );
}

function SaveIndicator() {
  const save = useEditorState((snapshot) => snapshot.save);
  const { store } = useEditor();
  if (save.state === 'error') {
    return (
      <span role="alert" className="flex min-w-0 items-center gap-1.5 truncate text-xs text-danger">
        <CloudOff size={14} aria-hidden /> Not saved: {save.message}
        <button type="button" className="underline" onClick={() => store.retrySave()}>
          Retry
        </button>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-subtle" role="status" data-testid="save-status" title={save.state === 'saved' ? 'All changes saved' : 'Saving…'}>
      {save.state === 'saved' ? <Check size={14} aria-hidden /> : <Loader2 size={14} aria-hidden className="animate-spin" />}
      <span className="sr-only lg:not-sr-only">{save.state === 'saved' ? 'All changes saved' : 'Saving…'}</span>
    </span>
  );
}

function Toolbar() {
  const { store, player, recording, assets, setSnapping, snapping, timelineZoom } = useEditor();
  const toast = useToast();
  const canUndo = useEditorState((snapshot) => snapshot.canUndo);
  const canRedo = useEditorState((snapshot) => snapshot.canRedo);
  const undoLabel = useEditorState((snapshot) => snapshot.undoLabel);
  const redoLabel = useEditorState((snapshot) => snapshot.redoLabel);
  const project = useEditorState((snapshot) => snapshot.project);
  const actions = useTimelineActions();
  const recordingActions = useRecordingActions({ onDeleted: () => window.location.replace('index.html') });
  const [exporting, setExporting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [help, setHelp] = useState(false);

  const announce = (label: string | null, redo: boolean) => {
    if (label) toast.show({ title: `${redo ? 'Redo' : 'Undo'}: ${label}` });
  };
  useEditorShortcuts({
    store,
    player,
    actions,
    onUndoRedo: announce,
    toggleSnapping: () => setSnapping(!snapping),
    zoomTimeline: (factor) => timelineZoom.current(factor),
    showHelp: () => setHelp(true),
  });

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-surface px-2 sm:gap-2 sm:px-3">
        <a href="index.html" className="flex shrink-0 items-center gap-1.5 rounded-lg p-1.5 text-fg-muted hover:bg-surface-3 hover:text-fg" aria-label="All recordings" title="All recordings">
          <ArrowLeft size={16} aria-hidden />
          <LogoMark size={22} className="hidden md:block" />
        </a>
        <div className="flex min-w-0 items-center gap-0.5">
          <h1 className="truncate text-sm font-semibold" title={recording.name}>
            {recording.name}
          </h1>
          <IconButton icon={PencilLine} label="Rename project" size="sm" className="size-7 shrink-0" tooltipSide="bottom" onClick={() => recordingActions.rename(recording)} />
          <IconButton icon={Trash2} label="Delete recording" size="sm" tone="danger" className="hidden size-7 shrink-0 sm:inline-flex" tooltipSide="bottom" onClick={() => recordingActions.remove(recording)} />
        </div>
        <SaveIndicator />
        <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
          <IconButton icon={Undo2} label={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Nothing to undo'} size="sm" disabled={!canUndo} tooltipSide="bottom" onClick={() => announce(store.undo(), false)} />
          <IconButton icon={Redo2} label={redoLabel ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'} size="sm" disabled={!canRedo} tooltipSide="bottom" onClick={() => announce(store.redo(), true)} />
          <span aria-hidden className="mx-1 hidden h-5 w-px bg-line sm:block" />
          <label className="flex items-center gap-1.5 text-xs text-fg-muted">
            <span className="hidden xl:inline">Aspect ratio</span>
            <span className="sr-only xl:hidden">Aspect ratio</span>
            <select
              value={project.aspectRatio}
              onChange={(event) => {
                const aspectRatio = event.target.value as AspectRatio;
                // Custom starts from the recording's own size (edited in the Canvas panel).
                store.edit('Change aspect ratio', (p) => ({
                  ...p,
                  aspectRatio,
                  customSize: aspectRatio === 'custom' ? (p.customSize ?? clampCustomSize({ width: recording.width ?? 1920, height: recording.height ?? 1080 })) : p.customSize,
                }));
              }}
              className="h-8 rounded-lg border border-line bg-surface-2 px-1.5 text-xs text-fg"
            >
              {ASPECTS.map((aspect) => (
                <option key={aspect.value} value={aspect.value}>
                  {aspect.label}
                </option>
              ))}
            </select>
          </label>
          <IconButton icon={Keyboard} label="Keyboard shortcuts (?)" size="sm" className="hidden md:inline-flex" tooltipSide="bottom" onClick={() => setHelp(true)} />
          <IconButton
            icon={downloading ? Loader2 : Download}
            label="Download original recording"
            size="sm"
            className="hidden sm:inline-flex"
            tooltipSide="bottom"
            disabled={downloading}
            onClick={() => {
              setDownloading(true);
              void recordingActions.download(recording).finally(() => setDownloading(false));
            }}
          />
          <IconButton icon={Settings} label="Open settings" size="sm" className="hidden md:inline-flex" tooltipSide="bottom" tooltipAlign="end" onClick={() => void sendMessage('page/open', { page: 'settings' })} />
          <Button
            variant="primary"
            size="sm"
            icon={Clapperboard}
            aria-label="Export video"
            className="ml-1"
            onClick={() => {
              player?.pause();
              void store.flush();
              setExporting(true);
            }}
          >
            <span className="hidden sm:inline">Export video</span>
          </Button>
        </div>
      </header>
      {recordingActions.dialogs}
      <RenderVideoDialog
        open={exporting}
        onClose={() => setExporting(false)}
        recording={recording}
        project={project}
        assets={assets}
        onSettingsChange={(exportSettings) => store.setSettings((p) => ({ ...p, exportSettings }))}
      />
      <Dialog open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts" description="Shortcuts work when no text field has focus.">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="contents">
              <dt>
                <kbd className="rounded border border-line-strong bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{shortcut.keys}</kbd>
              </dt>
              <dd className="text-fg-muted">{shortcut.action}</dd>
            </div>
          ))}
        </dl>
      </Dialog>
    </>
  );
}
