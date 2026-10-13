import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { aspectValue, contentRect, timelineScene } from '@/services/render/compose';
import type { FrameState } from '@/services/render/frameState';
import { TimelinePlayer } from '@/services/render/TimelinePlayer';
import { findClip } from '@/services/timeline/model';
import { updateTextClip } from '@/services/timeline/operations';
import { updateMarker } from '@/services/zoom/markers';
import type { NormalizedPoint, TextClip } from '@/types';
import { formatTimecode, parseTimecode, useEditor, useEditorState, usePlayheadListener } from '../state/EditorContext';
import { FramingOverlay } from './FramingOverlay';
import type { AssetUrls } from './useAssetUrls';

/** View options shared by the preview and the control bar (not part of the project). */
export interface PreviewOptions {
  /** Apply zoom effects in the preview. */
  previewZoom: boolean;
  /** Dragging the selected zoom effect's focus point. */
  framing: boolean;
  speed: number;
}
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * The edited timeline drawn on a canvas by the rendering engine, with direct manipulation of the
 * selected item (zoom framing, text position). The transport lives in the control bar.
 */
export function PreviewPane({ urls, options, onFramingChange }: { urls: AssetUrls; options: PreviewOptions; onFramingChange: (on: boolean) => void }) {
  const { store, recording, player, setPlayer } = useEditor();
  const project = useEditorState((snapshot) => snapshot.project);
  const selection = useEditorState((snapshot) => snapshot.selection);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const { previewZoom, framing, speed } = options;

  const source = useMemo(() => ({ width: recording.width ?? 1920, height: recording.height ?? 1080 }), [recording.width, recording.height]);
  const aspect = aspectValue(project.aspectRatio, source);
  const scene = useMemo(() => timelineScene(project, recording), [project.timeline, project.renderEffects, recording]);
  const selectedMarker = selection.length === 1 ? (project.timeline.zoomMarkers.find((marker) => marker.id === selection[0]) ?? null) : null;
  const selectedText = useMemo(() => {
    if (selection.length !== 1) return null;
    const clip = findClip(project.timeline, selection[0]!)?.clip;
    return clip?.type === 'text' ? clip : null;
  }, [project.timeline, selection]);
  const content = contentRect({ width: aspect, height: 1 }, source);
  const showZoom = previewZoom && !framing;
  const stageRef = useRef<HTMLDivElement>(null);
  const box = useFittedBox(stageRef, aspect);

  // One player for the editor's lifetime.
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const created = new TimelinePlayer(canvas, host, (state: FrameState) => {
      // Exposed for automated checks; cheap attribute writes, no React re-render.
      canvas.dataset.time = state.timeMs.toFixed(0);
      canvas.dataset.scale = state.camera.scale.toFixed(3);
      canvas.dataset.offset = `${state.camera.offsetX.toFixed(4)},${state.camera.offsetY.toFixed(4)}`;
    });
    setPlayer(created);
    return () => {
      created.destroy();
      setPlayer(null);
    };
  }, [setPlayer]);

  useEffect(() => {
    player?.setContent({ timeline: project.timeline, scene, zoom: showZoom, cameraLayout: project.cameraLayout, source, aspect, assets: urls });
  }, [player, project.timeline, project.cameraLayout, scene, showZoom, source, aspect, urls]);

  useEffect(() => player?.setRate(speed), [player, speed]);
  useEffect(() => {
    if (!selectedMarker && framing) onFramingChange(false);
  }, [selectedMarker, framing, onFramingChange]);

  const moveMarker = (position: NormalizedPoint) => {
    if (!selectedMarker) return;
    store.edit('Move zoom focus', (current) => ({
      ...current,
      timeline: { ...current.timeline, zoomMarkers: updateMarker(current.timeline.zoomMarkers, selectedMarker.id, { position }, current.timeline.durationMs) },
    }));
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col p-2 sm:p-4">
      <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden" data-testid="preview-stage">
        <div className="relative shrink-0 overflow-hidden rounded-lg bg-black shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] ring-1 ring-line" style={{ width: box.width, height: box.height }}>
          {/* Media elements live under the canvas: in the layout, so the browser keeps decoding them. */}
          <div ref={hostRef} className="absolute inset-0 overflow-hidden" aria-hidden />
          <canvas
            ref={canvasRef}
            data-testid="zoom-canvas"
            role="img"
            aria-label="Preview of the edited video"
            className="absolute inset-0 h-full w-full cursor-pointer"
            onClick={() => player?.toggle()}
          />
          {framing && selectedMarker && (
            <div
              className="absolute"
              style={{ left: `${(content.x / aspect) * 100}%`, top: `${content.y * 100}%`, width: `${(content.width / aspect) * 100}%`, height: `${content.height * 100}%` }}
            >
              <FramingOverlay marker={selectedMarker} onCommit={moveMarker} />
            </div>
          )}
          {selectedText && !framing && (
            <TextHandle
              clip={selectedText}
              onMove={(position, done) =>
                store.edit('Move text', (current) => ({ ...current, timeline: updateTextClip(current.timeline, selectedText.id, { position }) }), {
                  mergeKey: done ? undefined : `move-text:${selectedText.id}`,
                })
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** The largest box of the given aspect ratio that fits the element (kept up to date on resize). */
function useFittedBox(ref: RefObject<HTMLElement | null>, aspect: number): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  const width = Math.min(size.width, size.height * aspect);
  return { width: Math.floor(width), height: Math.floor(width / aspect) };
}

/**
 * Current time / duration. The time field is updated directly on every frame (no re-render) and
 * can be edited: type a time (e.g. 1:05.5) and press Enter to go there.
 */
export function Timecode() {
  const { player } = useEditor();
  const duration = useEditorState((snapshot) => snapshot.project.timeline.durationMs);
  const inputRef = useRef<HTMLInputElement>(null);
  const [invalid, setInvalid] = useState(false);
  usePlayheadListener((timeMs) => {
    const input = inputRef.current;
    if (input && document.activeElement !== input) input.value = formatTimecode(timeMs);
  }, player);

  const commit = () => {
    const input = inputRef.current;
    if (!input || !player) return;
    const ms = parseTimecode(input.value);
    setInvalid(ms === null);
    if (ms !== null) player.seek(ms);
  };

  return (
    <span className="flex items-center gap-0.5 font-mono text-xs text-fg-muted tabular-nums">
      <input
        ref={inputRef}
        aria-label="Playhead time"
        data-testid="playhead"
        defaultValue={formatTimecode(0)}
        aria-invalid={invalid || undefined}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            event.currentTarget.blur();
          }
        }}
        onBlur={() => {
          setInvalid(false);
          if (inputRef.current && player) inputRef.current.value = formatTimecode(player.time);
        }}
        className="w-[4.5rem] rounded-md border border-transparent bg-transparent px-1 py-0.5 text-fg hover:border-line focus:border-line-strong focus:bg-surface-2 aria-invalid:border-danger"
      />
      / {formatTimecode(duration)}
    </span>
  );
}

/** Dashed box over the selected text; drag it (or use the arrow keys) to move the text. */
function TextHandle({ clip, onMove }: { clip: TextClip; onMove: (position: NormalizedPoint, done: boolean) => void }) {
  const dragging = useRef<{ dx: number; dy: number } | null>(null);
  const pointIn = (event: PointerEvent<HTMLElement>) => {
    const frame = event.currentTarget.parentElement!.getBoundingClientRect();
    return { x: (event.clientX - frame.left) / frame.width, y: (event.clientY - frame.top) / frame.height };
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    onMove({ x: clamp01(clip.position.x + delta[0]!), y: clamp01(clip.position.y + delta[1]!) }, false);
  };
  return (
    <button
      type="button"
      aria-label={`Text “${clip.text}”: drag or use the arrow keys to move it`}
      data-testid="text-handle"
      className="absolute -translate-x-1/2 -translate-y-1/2 cursor-move touch-none rounded-md border-2 border-dashed border-accent-2 bg-accent-2/10 px-3 py-1 text-[11px] font-medium text-white shadow focus-visible:outline-2"
      style={{ left: `${clip.position.x * 100}%`, top: `${clip.position.y * 100}%` }}
      onPointerDown={(event) => {
        const point = pointIn(event);
        dragging.current = { dx: clip.position.x - point.x, dy: clip.position.y - point.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const point = pointIn(event);
        onMove({ x: clamp01(point.x + dragging.current.dx), y: clamp01(point.y + dragging.current.dy) }, false);
      }}
      onPointerUp={() => {
        dragging.current = null;
      }}
      onKeyDown={onKeyDown}
    >
      Move text
    </button>
  );
}
