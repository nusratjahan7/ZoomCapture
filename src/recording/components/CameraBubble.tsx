import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { VideoOff } from 'lucide-react';
import { CAMERA_BUBBLE_SCALE, type CameraLayout } from '@/types';
import { cn } from '@/utils/cn';
import { StreamVideo } from './StreamVideo';

export interface CameraBubbleProps {
  stream: MediaStream;
  layout: CameraLayout;
  hidden?: boolean;
  /** Called continuously while moving. */
  onMove: (layout: CameraLayout) => void;
  /** Called once a move ends (pointer up / key up), e.g. to persist the position. */
  onCommit: (layout: CameraLayout) => void;
}

/**
 * Draggable camera bubble over the screen preview. Its position is the camera placement saved with
 * the project. It can be moved with the mouse, touch or arrow keys (Shift for larger steps).
 */
export function CameraBubble({ stream, layout, hidden, onMove, onCommit }: CameraBubbleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [dragging, setDragging] = useState(false);
  const latest = useRef(layout);
  latest.current = layout;
  const scale = CAMERA_BUBBLE_SCALE[layout.size];

  const clampTo = (x: number, y: number): CameraLayout => {
    const container = ref.current?.parentElement?.getBoundingClientRect();
    const rx = scale / 2;
    const ry = container ? (rx * container.width) / container.height : rx;
    return {
      ...latest.current,
      x: Math.min(1 - rx, Math.max(rx, x)),
      y: Math.min(1 - ry, Math.max(ry, y)),
    };
  };

  // Keep the bubble inside the frame when its size changes.
  useEffect(() => {
    const clamped = clampTo(layout.x, layout.y);
    if (clamped.x !== layout.x || clamped.y !== layout.y) onCommit(clamped);
  }, [layout.size]);

  const moveToPointer = (event: PointerEvent<HTMLDivElement>) => {
    const container = ref.current?.parentElement?.getBoundingClientRect();
    if (!container) return latest.current;
    const next = clampTo((event.clientX - container.left) / container.width, (event.clientY - container.top) / container.height);
    onMove(next);
    return next;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    onMove(clampTo(layout.x + delta[0]!, layout.y + delta[1]!));
  };

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-roledescription="movable camera bubble"
      aria-label="Camera bubble"
      aria-describedby={hintId}
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
      onKeyUp={(event) => event.key.startsWith('Arrow') && onCommit(latest.current)}
      className={cn(
        'absolute z-10 aspect-square -translate-x-1/2 -translate-y-1/2 touch-none overflow-hidden rounded-full',
        'border-2 border-white/80 bg-surface-3 shadow-[0_12px_40px_-8px_rgb(0_0_0/0.8)]',
        dragging ? 'cursor-grabbing ring-4 ring-accent/50' : 'cursor-grab',
      )}
      style={{ left: `${layout.x * 100}%`, top: `${layout.y * 100}%`, width: `${scale * 100}%` }}
    >
      {hidden ? (
        <span className="flex h-full w-full items-center justify-center text-fg-muted">
          <VideoOff size={22} aria-label="Camera hidden" />
        </span>
      ) : (
        <StreamVideo stream={stream} label="Camera bubble preview" mirrored className="pointer-events-none object-cover" />
      )}
      <span id={hintId} className="sr-only">
        Drag, or use the arrow keys, to choose where the camera appears in the video.
      </span>
    </div>
  );
}
