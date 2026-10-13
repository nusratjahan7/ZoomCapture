import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cameraFor, visibleRegion } from '@/services/render/camera';
import type { NormalizedPoint, ZoomMarker } from '@/types';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Drag (or use the arrow keys) to move the selected effect's focus point. The rectangle is the part
 * of the frame that fills the video at full zoom, moved inwards at the edges exactly as rendered.
 */
export function FramingOverlay({ marker, onCommit }: { marker: ZoomMarker; onCommit: (position: NormalizedPoint) => void }) {
  const [position, setPosition] = useState(marker.position);
  const dragging = useRef(false);
  useEffect(() => setPosition(marker.position), [marker.position]);
  const region = visibleRegion(cameraFor(position, marker.effect === 'zoom' ? marker.scale : 1));

  const pointAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01((event.clientY - rect.top) / rect.height) };
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const next = { x: clamp01(position.x + delta[0]!), y: clamp01(position.y + delta[1]!) };
    setPosition(next);
    onCommit(next);
  };

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Zoom focus point"
      aria-valuetext={`${Math.round(position.x * 100)}% across, ${Math.round(position.y * 100)}% down`}
      data-testid="framing-overlay"
      className="absolute inset-0 cursor-crosshair touch-none bg-black/30 outline-none focus-visible:ring-2 focus-visible:ring-accent-2"
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setPosition(pointAt(event));
      }}
      onPointerMove={(event) => dragging.current && setPosition(pointAt(event))}
      onPointerUp={(event) => {
        if (!dragging.current) return;
        dragging.current = false;
        const next = pointAt(event);
        setPosition(next);
        onCommit(next);
      }}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute border-2 border-accent-2 shadow-[0_0_0_9999px_rgb(0_0_0/0.35)]"
        style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-accent-2/60"
        style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%` }}
      />
      <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-md bg-black/75 px-2 py-1 text-xs text-white">
        Drag to choose where this effect zooms
      </span>
    </div>
  );
}
