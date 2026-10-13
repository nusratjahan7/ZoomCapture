import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Copy,
  Eye,
  EyeOff,
  Lock,
  MoreHorizontal,
  Music,
  Power,
  Scissors,
  Sparkles,
  Trash2,
  Type,
  Unlock,
  Video,
  Volume2,
  VolumeX,
  Webcam,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react';
import { frameAt, type Filmstrip } from '@/services/media/filmstrip';
import { clipDuration, clipEnd, findClip, isMediaClip } from '@/services/timeline/model';
import { moveTrack, nearestFreeStart, removeTrack, updateMediaClip, updateTrack } from '@/services/timeline/operations';
import { snapPoints, snapSpan, snapTime } from '@/services/timeline/snapping';
import { markerSpan, updateMarker } from '@/services/zoom/markers';
import { IconButton } from '@/shared/components';
import type { MediaAsset, Timeline, TimelineClip, TimelineTrack, TrackKind, ZoomMarker } from '@/types';
import { cn } from '@/utils/cn';
import { formatTimecode, useEditor, useEditorState, usePlayheadListener } from '../state/EditorContext';
import { ContextMenu, type MenuState } from './ContextMenu';
import { useFilmstrips } from './useFilmstrips';
import { useTimelineActions } from './useTimelineActions';

const TRACK_ICONS: Record<TrackKind, LucideIcon> = { video: Video, camera: Webcam, audio: AudioLines, music: Music, text: Type };
const CLIP_COLORS: Record<TrackKind, string> = {
  video: 'border-accent/80 bg-accent/25',
  camera: 'border-accent-2/70 bg-accent-2/20',
  audio: 'border-success/60 bg-success/20',
  music: 'border-warning/60 bg-warning/15',
  text: 'border-accent-2/60 bg-accent-2/25',
};
/** Row heights: picture tracks are tall enough for preview frames. */
const ROW_HEIGHTS: Record<TrackKind | 'zoom', number> = { video: 60, camera: 48, audio: 36, music: 36, text: 34, zoom: 32 };
const RULER_HEIGHT = 28;
const MIN_PX_PER_SECOND = 8;
const MAX_PX_PER_SECOND = 600;
/** Snapping distance on screen. */
const SNAP_PX = 8;
/** Pointer movement below which a press is a click, not a drag. */
const DRAG_THRESHOLD_PX = 4;

interface DragBase {
  id: string;
  originX: number;
  originY: number;
  originMs: number;
  moved: boolean;
}
type Drag =
  | (DragBase & { kind: 'move'; duration: number; trackId: string })
  | (DragBase & { kind: 'trim'; edge: 'start' | 'end' })
  | (DragBase & { kind: 'marker-move' })
  | (DragBase & { kind: 'marker-hold' });

/** A drag as it starts (pointer origin and `moved` are filled in). */
type DragStart = Drag extends infer D ? (D extends Drag ? Omit<D, 'originX' | 'originY' | 'moved'> : never) : never;

/** Where a dragged item would land (drawn as a preview until the pointer is released). */
type Ghost =
  | { kind: 'clip'; id: string; startMs: number; trackId: string; valid: boolean }
  | { kind: 'trim'; id: string; edge: 'start' | 'end'; timeMs: number }
  | { kind: 'marker'; id: string; timeMs?: number; durationMs?: number };

/** Timeline rows from top to bottom: the tracks, with the zoom effects lane right under the video. */
type Row = { type: 'zoom' } | { type: 'track'; track: TimelineTrack; index: number };

function timelineRows(timeline: Timeline): Row[] {
  const rows: Row[] = timeline.tracks.map((track, index) => ({ type: 'track', track, index }));
  let lastVideo = -1;
  timeline.tracks.forEach((track, index) => {
    if (track.kind === 'video') lastVideo = index;
  });
  rows.splice(lastVideo + 1, 0, { type: 'zoom' });
  return rows;
}

const rowHeight = (row: Row) => ROW_HEIGHTS[row.type === 'zoom' ? 'zoom' : row.track.kind];

/** Height that shows every row (ruler, lanes and the horizontal scrollbar). */
export function timelineContentHeight(timeline: Timeline): number {
  return RULER_HEIGHT + timelineRows(timeline).reduce((sum, row) => sum + rowHeight(row), 0) + 16;
}

export function TimelinePanel() {
  const { store, player, assets, snapping, timelineZoom } = useEditor();
  const timeline = useEditorState((snapshot) => snapshot.project.timeline);
  const selection = useEditorState((snapshot) => snapshot.selection);
  const actions = useTimelineActions();
  const filmstrips = useFilmstrips(assets);
  const [pxPerSecond, setPxPerSecond] = useState<number | null>(null);
  const [ghost, setGhostState] = useState<Ghost | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // The latest preview is also kept in a ref: a release can arrive before React re-renders.
  const ghostRef = useRef<Ghost | null>(null);
  const setGhost = (next: Ghost | null) => {
    ghostRef.current = next;
    setGhostState(next);
  };
  /** The one scroll area (both directions); track headers stick to its left, the ruler to its top. */
  const scrollRef = useRef<HTMLDivElement>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  /** Width of the lanes that is visible (the scroll area minus the sticky headers). */
  const visibleLaneWidth = () => (scrollRef.current?.clientWidth ?? 800) - (headersRef.current?.offsetWidth ?? 0);
  const playheadRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const rows = useMemo(() => timelineRows(timeline), [timeline]);

  // Fit the whole timeline on first show.
  const duration = Math.max(timeline.durationMs, 1000);
  const fitScale = useCallback(() => {
    const width = visibleLaneWidth() - 32;
    return Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, (width / duration) * 1000));
  }, [duration]);
  useEffect(() => {
    if (pxPerSecond !== null || !scrollRef.current) return;
    setPxPerSecond(fitScale());
  }, [fitScale, pxPerSecond]);
  const scale = (pxPerSecond ?? 60) / 1000; // px per ms
  const width = Math.max(duration * scale + 160, 400);
  const x = (ms: number) => ms * scale;

  timelineZoom.current = (factor) =>
    setPxPerSecond((current) => (factor === 'fit' ? fitScale() : Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, (current ?? 60) * factor))));

  // Playhead: positioned directly on every frame; follows playback by scrolling.
  usePlayheadListener((timeMs, playing) => {
    const line = playheadRef.current;
    if (line) line.style.transform = `translateX(${x(timeMs)}px)`;
    const scroller = scrollRef.current;
    if (playing && scroller) {
      const position = x(timeMs);
      if (position > scroller.scrollLeft + visibleLaneWidth() - 40 || position < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, position - 40);
    }
  }, player);
  useEffect(() => {
    if (player && playheadRef.current) playheadRef.current.style.transform = `translateX(${x(player.time)}px)`;
  });

  const timeAtClientX = useCallback(
    (clientX: number) => {
      const rect = lanesRef.current!.getBoundingClientRect();
      return Math.max(0, (clientX - rect.left) / scale);
    },
    [scale],
  );

  const points = useCallback(
    (exclude: string) => (snapping ? snapPoints(timeline, { playheadMs: player?.time, exclude: new Set([exclude]) }) : []),
    [snapping, timeline, player],
  );

  // ── Ruler: click or drag to seek ────────────────────────────────────────────────
  const scrubbing = useRef(false);
  const scrub = (event: PointerEvent<HTMLDivElement>) => {
    const raw = timeAtClientX(event.clientX);
    const snapped = event.shiftKey || !snapping ? raw : snapTime(points(''), raw, SNAP_PX / scale).value;
    player?.seek(snapped);
  };

  // ── Clips and markers: select, move, trim ──────────────────────────────────────
  const select = (id: string, additive: boolean) => {
    if (additive) store.select(selection.includes(id) ? selection.filter((item) => item !== id) : [...selection, id]);
    else if (!(selection.length === 1 && selection[0] === id)) store.select([id]);
  };

  const begin = (event: PointerEvent<HTMLElement>, next: DragStart) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    drag.current = { ...next, originX: event.clientX, originY: event.clientY, moved: false } as Drag;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const trackAtClientY = (clientY: number, fallback: string): string => {
    const lanes = lanesRef.current?.querySelectorAll<HTMLElement>('[data-track-id]') ?? [];
    for (const lane of lanes) {
      const rect = lane.getBoundingClientRect();
      if (clientY >= rect.top && clientY < rect.bottom) return lane.dataset.trackId!;
    }
    return fallback;
  };

  const onDragMove = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.originX;
    const dy = event.clientY - current.originY;
    if (!current.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && (current.kind !== 'move' || Math.abs(dy) < DRAG_THRESHOLD_PX)) return;
    current.moved = true;
    const deltaMs = dx / scale;
    const threshold = event.shiftKey ? 0 : SNAP_PX / scale;
    if (current.kind === 'move') {
      const trackId = trackAtClientY(event.clientY, current.trackId);
      const track = timeline.tracks.find((candidate) => candidate.id === trackId);
      const desired = snapSpan(points(current.id), Math.max(0, current.originMs + deltaMs), current.duration, threshold).startMs;
      const resolved = track ? nearestFreeStart(track.clips, desired, current.duration, current.id) : null;
      setGhost({ kind: 'clip', id: current.id, startMs: resolved ?? desired, trackId, valid: resolved !== null });
    } else if (current.kind === 'trim') {
      setGhost({ kind: 'trim', id: current.id, edge: current.edge, timeMs: snapTime(points(current.id), current.originMs + deltaMs, threshold).value });
    } else if (current.kind === 'marker-move') {
      setGhost({ kind: 'marker', id: current.id, timeMs: Math.max(0, snapTime(points(current.id), current.originMs + deltaMs, threshold).value) });
    } else {
      setGhost({ kind: 'marker', id: current.id, durationMs: Math.max(300, current.originMs + deltaMs) });
    }
  };

  const onDragEnd = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    drag.current = null;
    const finalGhost = ghostRef.current;
    setGhost(null);
    if (!current) return;
    if (!current.moved) {
      select(current.id, event.shiftKey || event.ctrlKey || event.metaKey);
      return;
    }
    if (current.kind === 'move' && finalGhost?.kind === 'clip') actions.moveClip(current.id, finalGhost.startMs, finalGhost.trackId);
    else if (current.kind === 'trim' && finalGhost?.kind === 'trim') actions.trimClip(current.id, current.edge, finalGhost.timeMs);
    else if (finalGhost?.kind === 'marker') {
      const patch = finalGhost.timeMs !== undefined ? { timeMs: finalGhost.timeMs } : { durationMs: finalGhost.durationMs };
      store.edit(
        finalGhost.timeMs !== undefined ? 'Move zoom effect' : 'Change zoom duration',
        (project) => ({
          ...project,
          timeline: { ...project.timeline, zoomMarkers: updateMarker(project.timeline.zoomMarkers, current.id, patch, project.timeline.durationMs) },
        }),
        { select: [current.id] },
      );
    }
  };

  const cancelDrag = () => {
    drag.current = null;
    setGhost(null);
  };

  // ── Right-click menus ───────────────────────────────────────────────────────────
  /** Selects the item (unless it is already part of the selection) and opens its menu. */
  const openMenu = (event: MouseEvent<HTMLElement>, id: string, build: () => MenuState['items'], label: string) => {
    event.preventDefault();
    event.stopPropagation();
    cancelDrag();
    if (!selection.includes(id)) store.select([id]);
    // Keyboard (context-menu key / Shift+F10) has no pointer position: open by the item.
    const rect = event.currentTarget.getBoundingClientRect();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    setMenu({ x: fromKeyboard ? rect.left : event.clientX, y: fromKeyboard ? rect.bottom : event.clientY, items: build(), label });
  };

  const clipMenu = (clip: TimelineClip, track: TimelineTrack): MenuState['items'] => {
    const asset = isMediaClip(clip) ? assetMap.get(clip.assetId) : undefined;
    const audible = isMediaClip(clip) && track.kind !== 'camera' && asset?.kind !== 'image' && asset?.hasAudio !== false;
    const playhead = player?.time ?? 0;
    const items: MenuState['items'] = [
      { label: 'Split at playhead', icon: Scissors, shortcut: 'S', disabled: playhead <= clip.startMs || playhead >= clipEnd(clip), onSelect: () => actions.split() },
      { label: 'Duplicate', icon: Copy, shortcut: 'Ctrl+D', onSelect: () => actions.duplicateSelection() },
    ];
    if (audible && isMediaClip(clip)) {
      items.push({
        label: clip.muted ? 'Unmute clip' : 'Mute clip',
        icon: clip.muted ? Volume2 : VolumeX,
        onSelect: () => store.edit(clip.muted ? 'Unmute clip' : 'Mute clip', (p) => ({ ...p, timeline: updateMediaClip(p.timeline, clip.id, { muted: !clip.muted }) })),
      });
    }
    items.push('separator', { label: 'Delete', icon: Trash2, shortcut: 'Del', danger: true, onSelect: () => actions.deleteSelection() });
    return items;
  };

  const markerMenu = (marker: ZoomMarker): MenuState['items'] => [
    { label: 'Duplicate', icon: Copy, shortcut: 'Ctrl+D', onSelect: () => actions.duplicateSelection() },
    {
      label: marker.enabled ? 'Disable effect' : 'Enable effect',
      icon: Power,
      onSelect: () =>
        store.edit(marker.enabled ? 'Disable effect' : 'Enable effect', (p) => ({
          ...p,
          timeline: { ...p.timeline, zoomMarkers: updateMarker(p.timeline.zoomMarkers, marker.id, { enabled: !marker.enabled }, p.timeline.durationMs) },
        })),
    },
    'separator',
    { label: 'Delete', icon: Trash2, shortcut: 'Del', danger: true, onSelect: () => actions.deleteSelection() },
  ];

  // Ctrl + wheel zooms the timeline. A native, non-passive listener: React's wheel listener is
  // passive, so it could not stop the browser from zooming the whole page.
  const hasLanes = timeline.tracks.length > 0 || timeline.zoomMarkers.length > 0;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      timelineZoom.current(event.deltaY < 0 ? 1.25 : 0.8);
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, [hasLanes, timelineZoom]);

  // ── Rendering helpers ──────────────────────────────────────────────────────────
  const displayClip = (clip: TimelineClip): { startMs: number; endMs: number } => {
    if (ghost?.kind === 'clip' && ghost.id === clip.id) return { startMs: ghost.startMs, endMs: ghost.startMs + clipDuration(clip) };
    if (ghost?.kind === 'trim' && ghost.id === clip.id) {
      return ghost.edge === 'start'
        ? { startMs: Math.min(ghost.timeMs, clipEnd(clip) - 100), endMs: clipEnd(clip) }
        : { startMs: clip.startMs, endMs: Math.max(ghost.timeMs, clip.startMs + 100) };
    }
    return { startMs: clip.startMs, endMs: clipEnd(clip) };
  };

  const ticks = useMemo(() => rulerTicks(width / scale, pxPerSecond ?? 60), [width, scale, pxPerSecond]);

  const clipLabel = (clip: TimelineClip, asset: MediaAsset | undefined) =>
    clip.type === 'text' ? clip.text || 'Text' : asset ? (asset.origin === 'import' ? (asset.label ?? 'Imported') : (ASSET_NAMES[asset.kind] ?? asset.kind)) : 'Missing media';

  const onBackground = (event: PointerEvent<HTMLDivElement>) => {
    store.select([]);
    player?.seek(timeAtClientX(event.clientX));
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface" aria-label="Timeline">
      {!hasLanes ? (
        <p className="m-auto p-6 text-center text-sm text-fg-subtle">The timeline is empty. Add media from the Media panel, or add a text with T.</p>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onKeyDown={(event) => event.key === 'Escape' && cancelDrag()}>
          <div className="flex w-max min-w-full">
            {/* Track headers: stay on the left while scrolling sideways. */}
            <div ref={headersRef} className="sticky left-0 z-30 w-28 shrink-0 border-r border-line bg-surface sm:w-44">
              <div className="sticky top-0 z-10 border-b border-line bg-surface" style={{ height: RULER_HEIGHT }} />
              {rows.map((row, position) =>
                row.type === 'zoom' ? (
                  <div key="zoom" className="flex items-center gap-1.5 border-b border-line px-2 text-[11px] text-fg-muted" style={{ height: rowHeight(row) }}>
                    <ZoomIn size={13} aria-hidden className="shrink-0 text-accent" /> <span className="truncate">Zoom</span>
                  </div>
                ) : (
                  <TrackHeader
                    key={row.track.id}
                    track={row.track}
                    height={rowHeight(row)}
                    first={row.index === 0}
                    last={row.index === timeline.tracks.length - 1}
                    onMenu={(rect, items) => setMenu({ x: rect.left, y: rect.bottom, items, label: `${row.track.name} track` })}
                    data-row={position}
                  />
                ),
              )}
            </div>

            {/* Lanes */}
            <div className="min-w-0 flex-1">
              <div ref={lanesRef} className="relative" style={{ width }}>
                <div
                  className="sticky top-0 z-10 cursor-ew-resize touch-none border-b border-line bg-surface select-none"
                  style={{ height: RULER_HEIGHT }}
                  role="slider"
                  tabIndex={0}
                  aria-label="Time ruler: click or drag to move the playhead"
                  aria-valuemin={0}
                  aria-valuemax={Math.round(timeline.durationMs)}
                  aria-valuenow={Math.round(player?.time ?? 0)}
                  data-testid="time-ruler"
                  data-px-per-ms={scale}
                  onPointerDown={(event) => {
                    scrubbing.current = true;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    scrub(event);
                  }}
                  onPointerMove={(event) => scrubbing.current && scrub(event)}
                  onPointerUp={() => (scrubbing.current = false)}
                  onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                    if (!player) return;
                    const step = event.shiftKey ? 1000 : 100;
                    if (event.key === 'ArrowLeft') player.seek(player.time - step);
                    else if (event.key === 'ArrowRight') player.seek(player.time + step);
                    else return;
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  {ticks.map((tick) => (
                    <span key={tick.ms} className="absolute bottom-0 h-full pl-1 text-[10px] leading-7 text-fg-subtle" style={{ left: x(tick.ms) }}>
                      <span aria-hidden className="absolute bottom-0 left-0 h-2 w-px bg-line-strong" />
                      {tick.label}
                    </span>
                  ))}
                </div>

                {rows.map((row) =>
                  row.type === 'zoom' ? (
                    <Lane key="zoom" label="Zoom effects" testId="zoom-track" height={rowHeight(row)} onBackground={onBackground}>
                      {timeline.zoomMarkers.length === 0 && (
                        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-[11px] text-fg-subtle">
                          No zoom effects. Press Z to add one at the playhead.
                        </span>
                      )}
                      {timeline.zoomMarkers.map((marker) => (
                        <MarkerBlock
                          key={marker.id}
                          marker={applyMarkerGhost(marker, ghost)}
                          selected={selection.includes(marker.id)}
                          x={x}
                          onBodyDown={(event) => begin(event, { kind: 'marker-move', id: marker.id, originMs: marker.timeMs })}
                          onHoldDown={(event) => begin(event, { kind: 'marker-hold', id: marker.id, originMs: marker.durationMs })}
                          onMove={onDragMove}
                          onUp={onDragEnd}
                          onKeySelect={(additive) => select(marker.id, additive)}
                          onContextMenu={(event) => openMenu(event, marker.id, () => markerMenu(marker), 'Zoom effect')}
                        />
                      ))}
                    </Lane>
                  ) : (
                    <Lane
                      key={row.track.id}
                      label={`${row.track.name} track`}
                      trackId={row.track.id}
                      height={rowHeight(row)}
                      dim={row.track.hidden || row.track.muted}
                      highlight={ghost?.kind === 'clip' && ghost.trackId === row.track.id}
                      onBackground={onBackground}
                    >
                      {row.track.clips.map((clip) => {
                        const track = row.track;
                        if (ghost?.kind === 'clip' && ghost.id === clip.id && ghost.trackId !== track.id) return null;
                        const span = displayClip(clip);
                        const asset = isMediaClip(clip) ? assetMap.get(clip.assetId) : undefined;
                        const strip = asset ? filmstrips.get(asset.id) : undefined;
                        return (
                          <ClipBlock
                            key={clip.id}
                            label={clipLabel(clip, asset)}
                            clip={clip}
                            kind={track.kind}
                            missing={isMediaClip(clip) && !asset}
                            selected={selection.includes(clip.id)}
                            invalid={ghost?.kind === 'clip' && ghost.id === clip.id && !ghost.valid}
                            locked={Boolean(track.locked)}
                            left={x(span.startMs)}
                            width={Math.max(4, x(span.endMs - span.startMs))}
                            height={rowHeight(row) - 8}
                            filmstrip={strip && isMediaClip(clip) ? { strip, sourceStartMs: clip.sourceInMs + (span.startMs - clip.startMs), msPerPx: 1 / scale } : undefined}
                            onBodyDown={(event) => begin(event, { kind: 'move', id: clip.id, originMs: clip.startMs, duration: clipDuration(clip), trackId: track.id })}
                            onEdgeDown={(event, edge) => begin(event, { kind: 'trim', id: clip.id, edge, originMs: edge === 'start' ? clip.startMs : clipEnd(clip) })}
                            onMove={onDragMove}
                            onUp={onDragEnd}
                            onKeySelect={(additive) => select(clip.id, additive)}
                            onContextMenu={(event) => openMenu(event, clip.id, () => clipMenu(clip, track), clipLabel(clip, asset))}
                          />
                        );
                      })}
                      {ghost?.kind === 'clip' && ghost.trackId === row.track.id && !row.track.clips.some((clip) => clip.id === ghost.id) && (
                        <GhostClip timeline={timeline} ghost={ghost} x={x} />
                      )}
                    </Lane>
                  ),
                )}

                <div ref={playheadRef} aria-hidden className="pointer-events-none absolute top-0 bottom-0 left-0 z-20 w-0.5 -translate-x-px bg-rec" data-testid="timeline-playhead">
                  <span className="absolute top-0 -left-1.25 h-3 w-3 rounded-b-sm bg-rec" />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      <ContextMenu menu={menu} onClose={closeMenu} />
      <p className="sr-only" aria-live="polite">
        {ghost?.kind === 'clip' && !ghost.valid ? 'No room there.' : ''}
      </p>
    </section>
  );
}

function TrackHeader({
  track,
  height,
  first,
  last,
  onMenu,
  ...rest
}: {
  track: TimelineTrack;
  height: number;
  first: boolean;
  last: boolean;
  onMenu: (rect: DOMRect, items: MenuState['items']) => void;
  'data-row'?: number;
}) {
  const { store } = useEditor();
  const Icon = TRACK_ICONS[track.kind];
  const visual = track.kind !== 'audio' && track.kind !== 'music';
  const audible = track.kind === 'video' || track.kind === 'audio' || track.kind === 'music';
  const change = (label: string, patch: Parameters<typeof updateTrack>[2]) =>
    store.edit(label, (project) => ({ ...project, timeline: updateTrack(project.timeline, track.id, patch) }));
  const items = (): MenuState['items'] => [
    { label: 'Move up (draw above)', icon: ArrowUp, disabled: first, onSelect: () => store.edit('Move track', (p) => ({ ...p, timeline: moveTrack(p.timeline, track.id, -1) })) },
    { label: 'Move down', icon: ArrowDown, disabled: last, onSelect: () => store.edit('Move track', (p) => ({ ...p, timeline: moveTrack(p.timeline, track.id, 1) })) },
    { label: track.locked ? 'Unlock track' : 'Lock track', icon: track.locked ? Unlock : Lock, onSelect: () => change(track.locked ? 'Unlock track' : 'Lock track', { locked: !track.locked }) },
    'separator',
    {
      label: track.clips.length ? 'Remove track (delete its clips first)' : 'Remove track',
      icon: Trash2,
      danger: true,
      disabled: track.clips.length > 0,
      onSelect: () => store.edit('Remove track', (p) => ({ ...p, timeline: removeTrack(p.timeline, track.id) })),
    },
  ];
  return (
    <div
      className="group flex items-center gap-0.5 border-b border-line pr-1 pl-2"
      style={{ height }}
      data-track-header={track.id}
      data-row={rest['data-row']}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(new DOMRect(event.clientX, event.clientY, 0, 0), items());
      }}
    >
      <Icon size={13} aria-hidden className="mr-1 shrink-0 text-fg-muted" />
      <span className="min-w-0 flex-1 truncate text-[11px] text-fg" title={track.name}>
        {track.name}
      </span>
      {track.locked && <IconButton icon={Lock} label={`Unlock ${track.name}`} size="sm" className="size-6 text-warning" onClick={() => change('Unlock track', { locked: false })} />}
      {visual && (
        <IconButton
          icon={track.hidden ? EyeOff : Eye}
          label={track.hidden ? `Show ${track.name}` : `Hide ${track.name}`}
          size="sm"
          className="size-6"
          onClick={() => change(track.hidden ? 'Show track' : 'Hide track', { hidden: !track.hidden })}
        />
      )}
      {audible && (
        <IconButton
          icon={track.muted ? VolumeX : Volume2}
          label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
          size="sm"
          className="size-6"
          onClick={() => change(track.muted ? 'Unmute track' : 'Mute track', { muted: !track.muted })}
        />
      )}
      <IconButton
        icon={MoreHorizontal}
        label={`${track.name} track options`}
        size="sm"
        className="size-6"
        aria-haspopup="menu"
        onClick={(event) => onMenu(event.currentTarget.getBoundingClientRect(), items())}
      />
    </div>
  );
}

const ASSET_NAMES: Partial<Record<MediaAsset['kind'], string>> = {
  screen: 'Screen recording',
  camera: 'Camera',
  microphone: 'Microphone',
  'system-audio': 'Tab / system audio',
};

function Lane({
  children,
  label,
  trackId,
  testId,
  height,
  dim,
  highlight,
  onBackground,
}: {
  children: ReactNode;
  label: string;
  trackId?: string;
  testId?: string;
  height: number;
  dim?: boolean;
  highlight?: boolean;
  onBackground: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-track-id={trackId}
      data-testid={testId}
      className={cn('relative border-b border-line/70', dim && 'opacity-50', highlight && 'bg-accent/5')}
      style={{ height }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && event.button === 0) onBackground(event);
      }}
    >
      {children}
    </div>
  );
}

interface BlockHandlers {
  onMove: (event: PointerEvent<HTMLElement>) => void;
  onUp: (event: PointerEvent<HTMLElement>) => void;
  onKeySelect: (additive: boolean) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}

/** Preview frames along a clip: one tile per frame width, each showing the source at that spot. */
function FilmstripTiles({ strip, sourceStartMs, msPerPx, width, height }: { strip: Filmstrip; sourceStartMs: number; msPerPx: number; width: number; height: number }) {
  const tileWidth = Math.max(24, Math.round(height * strip.aspect));
  const count = Math.min(240, Math.ceil(width / tileWidth));
  const tiles = [];
  for (let i = 0; i < count; i++) {
    const url = frameAt(strip, sourceStartMs + (i + 0.5) * tileWidth * msPerPx);
    tiles.push(<img key={i} src={url} alt="" draggable={false} className="h-full shrink-0 object-cover" style={{ width: tileWidth }} />);
  }
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 flex overflow-hidden opacity-80">
      {tiles}
    </div>
  );
}

function ClipBlock({
  clip,
  label,
  kind,
  missing,
  selected,
  invalid,
  locked,
  left,
  width,
  height,
  filmstrip,
  onBodyDown,
  onEdgeDown,
  onMove,
  onUp,
  onKeySelect,
  onContextMenu,
}: BlockHandlers & {
  clip: TimelineClip;
  label: string;
  kind: TrackKind;
  missing: boolean;
  selected: boolean;
  invalid: boolean;
  locked: boolean;
  left: number;
  width: number;
  height: number;
  filmstrip?: { strip: Filmstrip; sourceStartMs: number; msPerPx: number };
  onBodyDown: (event: PointerEvent<HTMLElement>) => void;
  onEdgeDown: (event: PointerEvent<HTMLElement>, edge: 'start' | 'end') => void;
}) {
  const handlers = { onPointerMove: onMove, onPointerUp: onUp };
  const muted = clip.type === 'media' && clip.muted;
  return (
    <div
      className={cn(
        'absolute top-1 touch-none overflow-hidden rounded-lg border text-left',
        missing ? 'border-danger/70 bg-danger/15' : CLIP_COLORS[kind],
        selected && 'z-10 border-transparent ring-2 ring-warning',
        invalid && 'opacity-50 ring-2 ring-danger',
        locked ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing',
      )}
      style={{ left, width, height }}
      data-clip-id={clip.id}
      onContextMenu={onContextMenu}
    >
      {filmstrip && !missing && <FilmstripTiles {...filmstrip} width={width} height={height} />}
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${label}, ${formatTimecode(clip.startMs)} to ${formatTimecode(clipEnd(clip))}${missing ? ', media missing' : ''}`}
        className="absolute inset-0 px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent-2"
        onPointerDown={locked ? undefined : onBodyDown}
        onClick={(event) => {
          if (locked || event.detail === 0) onKeySelect(event.shiftKey || event.ctrlKey || event.metaKey);
        }}
        {...handlers}
      >
        <span
          className={cn(
            'inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-px text-[11px] font-medium text-white',
            filmstrip ? 'mt-1 bg-black/60' : height < 40 ? '' : 'mt-1',
          )}
        >
          {muted && <VolumeX size={11} aria-label="Muted" className="shrink-0" />}
          <span className="truncate">{label}</span>
        </span>
      </button>
      {!locked && (
        <>
          <span
            aria-hidden
            data-edge="start"
            className={cn('absolute inset-y-0 left-0 w-2 cursor-ew-resize hover:bg-white/40', selected && 'bg-warning')}
            onPointerDown={(event) => onEdgeDown(event, 'start')}
            {...handlers}
          />
          <span
            aria-hidden
            data-edge="end"
            className={cn('absolute inset-y-0 right-0 w-2 cursor-ew-resize hover:bg-white/40', selected && 'bg-warning')}
            onPointerDown={(event) => onEdgeDown(event, 'end')}
            {...handlers}
          />
        </>
      )}
    </div>
  );
}

function MarkerBlock({
  marker,
  selected,
  x,
  onBodyDown,
  onHoldDown,
  onMove,
  onUp,
  onKeySelect,
  onContextMenu,
}: BlockHandlers & {
  marker: ZoomMarker;
  selected: boolean;
  x: (ms: number) => number;
  onBodyDown: (event: PointerEvent<HTMLElement>) => void;
  onHoldDown: (event: PointerEvent<HTMLElement>) => void;
}) {
  const { startMs, endMs } = markerSpan(marker);
  const handlers = { onPointerMove: onMove, onPointerUp: onUp };
  const Icon = marker.effect === 'zoom' ? ZoomIn : Sparkles;
  return (
    <div
      className={cn(
        'absolute inset-y-1 touch-none overflow-hidden rounded-full border',
        marker.enabled ? 'border-accent/80 bg-accent/35' : 'border-line-strong bg-surface-3 opacity-60',
        selected && 'z-10 ring-2 ring-warning',
      )}
      style={{ left: x(startMs), width: Math.max(8, x(endMs - startMs)) }}
      onContextMenu={onContextMenu}
    >
      {/* The hold, between the zoom-in and zoom-out transitions. */}
      <span aria-hidden className={cn('absolute inset-y-0', marker.enabled ? 'bg-accent/70' : 'bg-line')} style={{ left: x(marker.transitionMs), width: x(marker.durationMs) }} />
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`Zoom effect at ${formatTimecode(marker.timeMs)}, ${marker.effect === 'zoom' ? `${marker.scale}×` : 'highlight'}${marker.enabled ? '' : ', disabled'}`}
        className="absolute inset-0 flex cursor-grab items-center gap-1 px-2 text-[11px] font-medium whitespace-nowrap text-white outline-none focus-visible:ring-2 focus-visible:ring-accent-2 active:cursor-grabbing"
        onPointerDown={onBodyDown}
        onClick={(event) => event.detail === 0 && onKeySelect(event.shiftKey)}
        {...handlers}
      >
        <Icon size={11} aria-hidden className="pointer-events-none shrink-0" />
        <span className="pointer-events-none">{marker.effect === 'zoom' ? `${marker.scale.toFixed(1)}×` : 'Highlight'}</span>
        {marker.positionMode === 'follow-cursor' && <span className="pointer-events-none opacity-75">· follow</span>}
      </button>
      <span
        aria-hidden
        data-edge="hold"
        title="Drag to change how long it holds"
        className="absolute inset-y-0 w-2 cursor-ew-resize hover:bg-white/40"
        style={{ left: x(marker.transitionMs + marker.durationMs) - 4 }}
        onPointerDown={onHoldDown}
        {...handlers}
      />
    </div>
  );
}

function GhostClip({ timeline, ghost, x }: { timeline: Timeline; ghost: Extract<Ghost, { kind: 'clip' }>; x: (ms: number) => number }) {
  const found = findClip(timeline, ghost.id);
  if (!found) return null;
  return (
    <div
      aria-hidden
      className={cn('pointer-events-none absolute inset-y-1 rounded-lg border-2 border-dashed', ghost.valid ? 'border-accent-2 bg-accent-2/15' : 'border-danger bg-danger/10')}
      style={{ left: x(ghost.startMs), width: x(clipDuration(found.clip)) }}
    />
  );
}

function applyMarkerGhost(marker: ZoomMarker, ghost: Ghost | null): ZoomMarker {
  if (ghost?.kind !== 'marker' || ghost.id !== marker.id) return marker;
  return { ...marker, timeMs: ghost.timeMs ?? marker.timeMs, durationMs: ghost.durationMs ?? marker.durationMs };
}

/** Ruler ticks at a spacing that keeps labels readable at the current zoom. */
export function rulerTicks(totalMs: number, pxPerSecond: number): Array<{ ms: number; label: string }> {
  const steps = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000];
  const step = steps.find((candidate) => (candidate / 1000) * pxPerSecond >= 70) ?? 600_000;
  const ticks: Array<{ ms: number; label: string }> = [];
  for (let ms = 0; ms <= totalMs; ms += step) {
    const seconds = ms / 1000;
    ticks.push({ ms, label: step < 1000 ? `${seconds.toFixed(step < 500 ? 2 : 1)}s` : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` });
  }
  return ticks;
}
