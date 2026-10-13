import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { VideoOff } from 'lucide-react';
import { CAMERA_BUBBLE_LIMITS, cameraBubbleScale, type CameraLayout } from '@/types';
import { cn } from '@/utils/cn';
import { StreamVideo } from './StreamVideo';

export interface CameraBubbleProps {
  stream: MediaStream;
  layout: CameraLayout;
  hidden?: boolean;
  /** Called continuously while moving or resizing. */
  onMove: (layout: CameraLayout) => void;
  /** Called once a move or resize ends (pointer up / key up), e.g. to persist the layout. */
  onCommit: (layout: CameraLayout) => void;
}

/** The handle sits on the circle's edge at the bottom-right (45°): 0.5 + 0.5·cos 45° of the box. */
const HANDLE_AT = 0.5 + 0.5 * Math.SQRT1_2;

/**
 * Draggable, resizable camera bubble over the screen preview. Its position and size are the camera
 * placement saved with the project (and applied to the video while recording). Move it with the
 * mouse, touch or arrow keys (Shift for larger steps); resize it from the handle on its
 * bottom-right edge, or with the arrow keys / + and − on that handle. It stays a circle, within
 * the size limits and inside the frame.
 */
export function CameraBubble({ stream, layout, hidden, onMove, onCommit }: CameraBubbleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [dragging, setDragging] = useState(false);
  /** While resizing: the bubble's top-left corner (stays put) in container pixels. */
  const resizing = useRef<{ left: number; top: number } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const latest = useRef(layout);
  latest.current = layout;
  const scale = cameraBubbleScale(layout);

  const containerRect = () => ref.current?.parentElement?.getBoundingClientRect() ?? null;

  /** The layout with its centre moved inside the frame for the given diameter. */
  const clampTo = (x: number, y: number, diameter = scale, base = latest.current): CameraLayout => {
    const container = containerRect();
    const rx = diameter / 2;
    const ry = container ? (rx * container.width) / container.height : rx;
    return {
      ...base,
      x: Math.min(1 - rx, Math.max(rx, x)),
      y: Math.min(1 - ry, Math.max(ry, y)),
    };
  };

  /** Largest diameter that still fits the frame (a circle as tall as the frame at most). */
  const maxScale = () => {
    const container = containerRect();
    const fit = container && container.width > 0 ? container.height / container.width : 1;
    return Math.min(CAMERA_BUBBLE_LIMITS.max, fit);
  };

  /** A new diameter, keeping the top-left of the bubble where it is when possible. */
  const resizedTo = (diameter: number, anchor?: { left: number; top: number }): CameraLayout => {
    const container = containerRect();
    const next = Math.min(maxScale(), Math.max(CAMERA_BUBBLE_LIMITS.min, diameter));
    const base = { ...latest.current, scale: Math.round(next * 10_000) / 10_000 };
    if (!container) return base;
    const left = anchor?.left ?? (latest.current.x - scale / 2) * container.width;
    const top = anchor?.top ?? latest.current.y * container.height - (scale / 2) * container.width;
    const radius = (next / 2) * container.width;
    return clampTo((left + radius) / container.width, (top + radius) / container.height, next, base);
  };

  // Keep the bubble inside the frame when its size changes (preset sizes, window resizes).
  useEffect(() => {
    const clamped = clampTo(layout.x, layout.y);
    if (clamped.x !== layout.x || clamped.y !== layout.y) onCommit(clamped);
  }, [scale]);

  const moveToPointer = (event: PointerEvent<HTMLElement>) => {
    const container = containerRect();
    if (!container) return latest.current;
    const next = clampTo((event.clientX - container.left) / container.width, (event.clientY - container.top) / container.height);
    onMove(next);
    return next;
  };

  /** The diameter that puts the bottom-right edge under the pointer (top-left corner fixed). */
  const resizeToPointer = (event: PointerEvent<HTMLElement>) => {
    const container = containerRect();
    const anchor = resizing.current;
    if (!container || !anchor) return latest.current;
    // Distance from the top-left corner along the diagonal, so diagonal drags feel natural.
    const dx = event.clientX - container.left - anchor.left;
    const dy = event.clientY - container.top - anchor.top;
    const diameterPx = Math.max(dx, dy) / HANDLE_AT;
    const next = resizedTo(diameterPx / container.width, anchor);
    onMove(next);
    return next;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const step = event.shiftKey ? 0.05 : 0.01;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    onMove(clampTo(layout.x + delta[0]!, layout.y + delta[1]!));
  };

  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 0.04 : 0.01;
    const change = { ArrowRight: step, ArrowDown: step, '+': step, '=': step, ArrowLeft: -step, ArrowUp: -step, '-': -step }[event.key];
    if (change === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    onMove(resizedTo(scale + change));
  };

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-roledescription="movable camera bubble"
      aria-label="Camera bubble"
      aria-describedby={hintId}
      data-testid="camera-bubble"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => dragging && moveToPointer(event)}
      onPointerUp={(event) => {
        if (!dragging) return;
        setDragging(false);
        onCommit(moveToPointer(event));
      }}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => event.target === event.currentTarget && event.key.startsWith('Arrow') && onCommit(latest.current)}
      className={cn('group absolute z-10 aspect-square -translate-x-1/2 -translate-y-1/2 touch-none rounded-full', dragging ? 'cursor-grabbing' : 'cursor-grab')}
      style={{ left: `${layout.x * 100}%`, top: `${layout.y * 100}%`, width: `${scale * 100}%` }}
    >
      <div
        className={cn(
          'h-full w-full overflow-hidden rounded-full border-2 border-white/80 bg-surface-3 shadow-[0_12px_40px_-8px_rgb(0_0_0/0.8)]',
          (dragging || isResizing) && 'ring-4 ring-accent/50',
        )}
      >
        {hidden ? (
          <span className="flex h-full w-full items-center justify-center text-fg-muted">
            <VideoOff size={22} aria-label="Camera hidden" />
          </span>
        ) : (
          <StreamVideo stream={stream} label="Camera bubble preview" mirrored className="pointer-events-none object-cover" />
        )}
      </div>
      <button
        type="button"
        aria-label={`Resize camera bubble (${Math.round(scale * 100)}% of the frame width)`}
        title="Drag to resize"
        data-testid="camera-bubble-resize"
        className={cn(
          'absolute size-4 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize touch-none rounded-full border-2 border-white bg-accent-2 shadow',
          'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
          isResizing && 'opacity-100',
        )}
        style={{ left: `${HANDLE_AT * 100}%`, top: `${HANDLE_AT * 100}%` }}
        onPointerDown={(event) => {
          event.stopPropagation();
          const container = containerRect();
          if (!container) return;
          resizing.current = {
            left: (latest.current.x - scale / 2) * container.width,
            top: latest.current.y * container.height - (scale / 2) * container.width,
          };
          setIsResizing(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (resizing.current) resizeToPointer(event);
        }}
        onPointerUp={(event) => {
          if (!resizing.current) return;
          const next = resizeToPointer(event);
          resizing.current = null;
          setIsResizing(false);
          onCommit(next);
        }}
        onPointerCancel={() => {
          if (!resizing.current) return;
          resizing.current = null;
          setIsResizing(false);
          onCommit(latest.current);
        }}
        onKeyDown={onHandleKeyDown}
        onKeyUp={(event) => ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-'].includes(event.key) && onCommit(latest.current)}
      />
      <span id={hintId} className="sr-only">
        Drag, or use the arrow keys, to choose where the camera appears in the video. Drag the handle on its bottom-right edge, or focus it and use the arrow keys, to resize it.
      </span>
    </div>
  );
}
