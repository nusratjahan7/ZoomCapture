import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cameraStyleOf } from '@/services/render/enhancements';
import { CAMERA_BUBBLE_LIMITS, cameraBubbleScale, type CameraLayout } from '@/types';

/**
 * Moves and resizes the camera bubble in the preview (shown while the Camera panel is open). It is
 * kept inside the frame, as it is drawn. Arrow keys move it, + and − resize it.
 */
export function CameraHandle({ layout, frameAspect, onChange }: { layout: CameraLayout; frameAspect: number; onChange: (layout: CameraLayout, done: boolean) => void }) {
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: 'move' | 'resize'; dx: number; dy: number } | null>(null);
  const [draft, setDraft] = useState<CameraLayout | null>(null);
  const current = draft ?? layout;
  const style = cameraStyleOf(current);
  const width = cameraBubbleScale(current);
  const height = (width * frameAspect) / style.aspect; // as a fraction of the frame's height
  // Where it is drawn: kept inside the frame.
  const x = Math.min(1 - width / 2, Math.max(width / 2, current.x));
  const y = Math.min(1 - height / 2, Math.max(height / 2, current.y));

  const pointAt = (event: PointerEvent) => {
    const rect = area.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };
  const clampLayout = (next: CameraLayout): CameraLayout => {
    const w = Math.min(CAMERA_BUBBLE_LIMITS.max, Math.max(CAMERA_BUBBLE_LIMITS.min, cameraBubbleScale(next)));
    const h = (w * frameAspect) / style.aspect;
    const round = (value: number) => Math.round(value * 10_000) / 10_000;
    return { ...next, scale: round(w), x: round(Math.min(1 - w / 2, Math.max(w / 2, next.x))), y: round(Math.min(1 - h / 2, Math.max(h / 2, next.y))) };
  };
  const apply = (next: CameraLayout, done: boolean) => {
    setDraft(done ? null : next);
    onChange(next, done);
  };
  const onMove = (event: PointerEvent<HTMLElement>, done = false) => {
    const active = drag.current;
    if (!active) return;
    const point = pointAt(event);
    if (done) drag.current = null;
    if (active.kind === 'move') apply(clampLayout({ ...layout, x: point.x + active.dx, y: point.y + active.dy }), done);
    // Resize from the bottom-right corner, keeping the top-left corner where it is.
    else apply(clampLayout(resizeTo(point)), done);
  };
  const resizeTo = (point: { x: number; y: number }): CameraLayout => {
    const left = x - width / 2;
    const top = y - height / 2;
    const w = Math.max(point.x - left, ((point.y - top) * style.aspect) / frameAspect);
    const h = (w * frameAspect) / style.aspect;
    return { ...layout, scale: w, x: left + w / 2, y: top + h / 2 };
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    let next: CameraLayout | null = null;
    if (moves[event.key]) next = { ...layout, x: x + moves[event.key]![0], y: y + moves[event.key]![1] };
    else if (event.key === '+' || event.key === '=') next = { ...layout, scale: width + step / 2 };
    else if (event.key === '-') next = { ...layout, scale: width - step / 2 };
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(clampLayout(next), true);
  };

  return (
    <div ref={area} className="pointer-events-none absolute inset-0" data-testid="camera-handle-area">
      <div
        role="group"
        tabIndex={0}
        aria-roledescription="movable camera bubble"
        aria-label="Camera bubble: drag to move, drag the corner to resize, or use the arrow keys and + / −"
        data-testid="camera-handle"
        className="pointer-events-auto absolute cursor-move touch-none border-2 border-dashed border-accent-2 outline-none focus-visible:ring-2 focus-visible:ring-white"
        style={{
          left: `${(x - width / 2) * 100}%`,
          top: `${(y - height / 2) * 100}%`,
          width: `${width * 100}%`,
          height: `${height * 100}%`,
          borderRadius: style.shape === 'circle' ? '50%' : `${style.radius * 100}%`,
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          const point = pointAt(event);
          drag.current = { kind: 'move', dx: x - point.x, dy: y - point.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => onMove(event)}
        onPointerUp={(event) => onMove(event, true)}
        onKeyDown={onKeyDown}
      >
        <span
          aria-hidden
          data-handle="resize"
          className="absolute right-[12%] bottom-[12%] size-3.5 cursor-nwse-resize rounded-full border-2 border-white bg-accent-2 shadow"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            drag.current = { kind: 'resize', dx: 0, dy: 0 };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => onMove(event)}
          onPointerUp={(event) => onMove(event, true)}
        />
      </div>
    </div>
  );
}
