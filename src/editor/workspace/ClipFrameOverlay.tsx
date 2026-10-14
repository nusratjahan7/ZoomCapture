import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Check, Crop, Move, RotateCcw } from 'lucide-react';
import { clampTransform, cropEdge, croppedSize, fittedTransform, placement, resizeFromCorner, type Size } from '@/services/render/clipFrame';
import type { ClipTransform, MediaClip } from '@/types';
import { cn } from '@/utils/cn';

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
type Edge = 'left' | 'top' | 'right' | 'bottom';
type Drag = { kind: 'move'; start: ClipTransform; x: number; y: number } | { kind: 'corner'; corner: Corner; start: ClipTransform } | { kind: 'edge'; edge: Edge; start: ClipTransform; x: number; y: number };

const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const EDGES: Edge[] = ['left', 'top', 'right', 'bottom'];
const CURSOR: Record<Corner | Edge, string> = {
  'top-left': 'cursor-nwse-resize',
  'bottom-right': 'cursor-nwse-resize',
  'top-right': 'cursor-nesw-resize',
  'bottom-left': 'cursor-nesw-resize',
  left: 'cursor-ew-resize',
  right: 'cursor-ew-resize',
  top: 'cursor-ns-resize',
  bottom: 'cursor-ns-resize',
};
const pct = (value: number) => `${value * 100}%`;

/**
 * Move, resize and crop the selected clip's picture right in the preview (over the frame area).
 * Drag the picture to move it, a corner to resize it (it keeps its shape), or in Crop mode an edge
 * to cut it; the rest of the picture stays where it is. Arrow keys move it, + and − resize it.
 * Changes while dragging are one undo step.
 */
export function ClipFrameOverlay({
  clip,
  source,
  frameAspect,
  onChange,
  onDone,
}: {
  clip: MediaClip;
  /** Size of the clip's picture (any unit; its shape is what matters). */
  source: Size;
  /** Width / height of the frame area. */
  frameAspect: number;
  /** `done` is false while dragging (merged into one undo step), true at the end. */
  onChange: (transform: ClipTransform | undefined, done: boolean) => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<'move' | 'crop'>('move');
  const committed = clip.transform ?? fittedTransform(source, frameAspect);
  const [draft, setDraft] = useState<ClipTransform | null>(null);
  const drag = useRef<Drag | null>(null);
  const area = useRef<HTMLDivElement>(null);
  useEffect(() => setDraft(null), [clip.id, clip.transform]);
  const current = draft ?? committed;
  const shown = placement(source, frameAspect, current);
  // The whole (uncropped) picture, outlined while cropping.
  const fullWidth = shown.width / (1 - current.crop.left - current.crop.right);
  const fullHeight = shown.height / (1 - current.crop.top - current.crop.bottom);
  const full = { x: shown.x - current.crop.left * fullWidth, y: shown.y - current.crop.top * fullHeight, width: fullWidth, height: fullHeight };

  const pointAt = (event: PointerEvent) => {
    const rect = area.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };
  const update = (next: ClipTransform, done: boolean) => {
    setDraft(done ? null : next);
    onChange(next, done);
  };
  const begin = (event: PointerEvent<HTMLElement>, next: Drag) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    drag.current = next;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLElement>, done = false) => {
    const active = drag.current;
    if (!active) return;
    const point = pointAt(event);
    let next: ClipTransform;
    if (active.kind === 'move') {
      next = clampTransform({ ...active.start, x: active.start.x + point.x - active.x, y: active.start.y + point.y - active.y }, source, frameAspect);
    } else if (active.kind === 'corner') {
      next = resizeFromCorner(active.start, source, frameAspect, active.corner, point);
    } else {
      const inward = { left: point.x - active.x, right: active.x - point.x, top: point.y - active.y, bottom: active.y - point.y }[active.edge];
      next = cropEdge(active.start, source, frameAspect, active.edge, inward);
    }
    if (done) drag.current = null;
    update(next, done);
  };
  const handlers = { onPointerMove: (event: PointerEvent<HTMLElement>) => move(event), onPointerUp: (event: PointerEvent<HTMLElement>) => move(event, true) };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    const deltas: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    let next: ClipTransform | null = null;
    if (deltas[event.key]) {
      const [dx, dy] = deltas[event.key]!;
      next = clampTransform({ ...committed, x: committed.x + dx, y: committed.y + dy }, source, frameAspect);
    } else if (event.key === '+' || event.key === '=' || event.key === '-') {
      // Resize around the centre.
      const factor = event.key === '-' ? 1 / (1 + step * 5) : 1 + step * 5;
      const width = committed.width * factor;
      const height = (shown.height * width) / shown.width;
      next = clampTransform({ ...committed, width, x: shown.x + shown.width / 2 - width / 2, y: shown.y + shown.height / 2 - height / 2 }, source, frameAspect);
    }
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(next, true);
  };

  const picture = croppedSize(source, current.crop);
  return (
    <div ref={area} className="absolute inset-0" data-testid="clip-frame">
      {mode === 'crop' && (
        <div
          aria-hidden
          className="pointer-events-none absolute border border-dashed border-white/50 bg-black/25"
          style={{ left: pct(full.x), top: pct(full.y), width: pct(full.width), height: pct(full.height) }}
        />
      )}
      <div
        role="group"
        tabIndex={0}
        aria-roledescription="movable picture"
        aria-label={`Picture: ${Math.round(shown.width * 100)}% of the frame wide. Drag to move, arrow keys to move, + and − to resize.`}
        data-testid="clip-frame-box"
        className="absolute cursor-move touch-none border-2 border-accent-2 outline-none focus-visible:ring-2 focus-visible:ring-white"
        style={{ left: pct(shown.x), top: pct(shown.y), width: pct(shown.width), height: pct(shown.height) }}
        onPointerDown={(event) => {
          const point = pointAt(event);
          begin(event, { kind: 'move', start: committed, x: point.x, y: point.y });
        }}
        onKeyDown={onKeyDown}
        {...handlers}
      >
        {mode === 'move'
          ? CORNERS.map((corner) => (
              <span
                key={corner}
                aria-hidden
                data-handle={corner}
                // Just inside the corners, so they can be grabbed even when the picture fills the frame.
                className={cn(
                  'absolute size-3.5 rounded-sm border-2 border-white bg-accent-2 shadow',
                  CURSOR[corner],
                  corner.startsWith('top') ? 'top-0.5' : 'bottom-0.5',
                  corner.endsWith('left') ? 'left-0.5' : 'right-0.5',
                )}
                onPointerDown={(event) => begin(event, { kind: 'corner', corner, start: committed })}
                {...handlers}
              />
            ))
          : EDGES.map((edge) => {
              const horizontal = edge === 'left' || edge === 'right';
              return (
                <span
                  key={edge}
                  aria-hidden
                  data-handle={edge}
                  className={cn(
                    'absolute rounded-full border-2 border-white bg-accent-2 shadow',
                    CURSOR[edge],
                    horizontal ? 'top-1/2 h-8 w-2 -translate-y-1/2' : 'left-1/2 h-2 w-8 -translate-x-1/2',
                    edge === 'left' && 'left-0.5',
                    edge === 'right' && 'right-0.5',
                    edge === 'top' && 'top-0.5',
                    edge === 'bottom' && 'bottom-0.5',
                  )}
                  onPointerDown={(event) => {
                    const point = pointAt(event);
                    begin(event, { kind: 'edge', edge, start: committed, x: point.x, y: point.y });
                  }}
                  {...handlers}
                />
              );
            })}
      </div>
      {/* At the top of the frame, or at the bottom when the picture is up there (never over it). */}
      <div
        className={cn(
          'absolute left-2 flex items-center gap-1 rounded-lg border border-line-strong bg-surface/95 p-1 text-xs shadow-lg',
          shown.y + shown.height / 2 < 0.5 ? 'bottom-2' : 'top-2',
        )}
        role="toolbar"
        aria-label="Picture position"
      >
        {(
          [
            ['move', Move, 'Move & resize'],
            ['crop', Crop, 'Crop'],
          ] as const
        ).map(([value, Icon, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
            className={cn('inline-flex h-7 items-center gap-1 rounded-md px-2', mode === value ? 'bg-accent/20 text-accent' : 'text-fg-muted hover:bg-surface-3 hover:text-fg')}
          >
            <Icon size={13} aria-hidden /> {label}
          </button>
        ))}
        <button
          type="button"
          disabled={!clip.transform}
          onClick={() => onChange(undefined, true)}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-fg-muted hover:bg-surface-3 hover:text-fg disabled:opacity-40"
        >
          <RotateCcw size={13} aria-hidden /> Reset
        </button>
        <button type="button" onClick={onDone} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-fg-muted hover:bg-surface-3 hover:text-fg">
          <Check size={13} aria-hidden /> Done
        </button>
        <span className="px-1 font-mono text-[10px] text-fg-subtle tabular-nums" aria-live="polite">
          {Math.round(picture.width)}×{Math.round(picture.height)}
        </span>
      </div>
    </div>
  );
}
