import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { Check, Crop, Loader2, Pause, Play } from 'lucide-react';
import { cameraFor, visibleRegion } from '@/services/render/camera';
import type { FrameState, RenderScene } from '@/services/render/frameState';
import { PreviewRenderer } from '@/services/render/PreviewRenderer';
import { Button, IconButton } from '@/shared/components';
import { CAMERA_BUBBLE_SCALE, type CameraLayout, type NormalizedPoint, type ZoomMarker } from '@/types';

/** Current playback position in ms, updated every frame while playing. */
export function useVideoTime(ref: RefObject<HTMLVideoElement | null>, ready: boolean): { ms: number; playing: boolean } {
  const [state, setState] = useState({ ms: 0, playing: false });
  useEffect(() => {
    const video = ref.current;
    if (!video || !ready) return;
    let frame = 0;
    const read = () => setState({ ms: video.currentTime * 1000, playing: !video.paused && !video.ended });
    const loop = () => {
      read();
      if (!video.paused) frame = requestAnimationFrame(loop);
    };
    const onPlay = () => {
      cancelAnimationFrame(frame);
      loop();
    };
    const events = ['seeked', 'seeking', 'pause', 'ended', 'loadedmetadata', 'timeupdate'] as const;
    events.forEach((name) => video.addEventListener(name, read));
    video.addEventListener('play', onPlay);
    read();
    return () => {
      cancelAnimationFrame(frame);
      events.forEach((name) => video.removeEventListener(name, read));
      video.removeEventListener('play', onPlay);
    };
  }, [ref, ready]);
  return state;
}

const formatTime = (ms: number) => {
  const total = Math.max(0, ms) / 1000;
  return `${Math.floor(total / 60)}:${(total % 60).toFixed(1).padStart(4, '0')}`;
};

const SPEEDS = [0.5, 1, 1.5, 2] as const;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * The editor preview: the recording drawn on a canvas by the same renderer that produces the
 * final video (services/render), so what you see here is what gets rendered.
 *
 * The <video> elements stay in the layout underneath the canvas: they provide playback, audio
 * and decoded frames, and remain visible to the browser so it keeps decoding them.
 */
export function ZoomPreview({
  videoUrl,
  cameraUrl,
  cameraLayout: layoutProp,
  aspectRatio,
  scene,
  selectedMarker,
  previewZoom,
  onPreviewZoomChange,
  onMarkerPositionChange,
  videoRef,
  cameraRef,
  label,
}: {
  videoUrl: string | null;
  cameraUrl: string | null;
  cameraLayout?: CameraLayout;
  aspectRatio: number;
  /** Markers, clicks, pointer path and overlays (`zoom` is controlled by `previewZoom`). */
  scene: Omit<RenderScene, 'zoom'>;
  selectedMarker: ZoomMarker | null;
  previewZoom: boolean;
  onPreviewZoomChange: (on: boolean) => void;
  onMarkerPositionChange: (marker: ZoomMarker, position: NormalizedPoint) => void;
  videoRef: RefObject<HTMLVideoElement | null>;
  cameraRef: RefObject<HTMLVideoElement | null>;
  label: string;
}) {
  const { ms, playing } = useVideoTime(videoRef, Boolean(videoUrl));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PreviewRenderer | null>(null);
  const [scale, setScale] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [framing, setFraming] = useState(false);
  const duration = (videoRef.current?.duration ?? 0) * 1000;
  const wide = aspectRatio >= 16 / 9;
  // Stable identity across project reloads, so the renderer is only rebuilt when the layout changes.
  const layoutKey = layoutProp ? `${layoutProp.x},${layoutProp.y},${layoutProp.size}` : '';
  const cameraLayout = useMemo(() => layoutProp, [layoutKey]);
  const bubbleWidth = cameraLayout ? CAMERA_BUBBLE_SCALE[cameraLayout.size] * 100 : 0;

  // Adjusting a marker's framing shows the whole frame with the zoom area drawn on top.
  const showZoom = previewZoom && !framing;
  const renderScene = useMemo<RenderScene>(() => ({ ...scene, zoom: showZoom }), [scene, showZoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || !videoUrl) return;
    const renderer = new PreviewRenderer(canvas, (state: FrameState) => {
      // Exposed for automated checks; cheap DOM attribute writes, no React re-render.
      canvas.dataset.time = state.timeMs.toFixed(0);
      canvas.dataset.scale = state.camera.scale.toFixed(3);
      canvas.dataset.offset = `${state.camera.offsetX.toFixed(4)},${state.camera.offsetY.toFixed(4)}`;
      setScale(Math.round(state.camera.scale * 10) / 10);
    });
    rendererRef.current = renderer;
    renderer.setSources({ video, camera: cameraUrl ? cameraRef.current : null, cameraLayout });
    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [videoUrl, cameraUrl, cameraLayout, videoRef, cameraRef]);

  useEffect(() => rendererRef.current?.setScene(renderScene), [renderScene, videoUrl, cameraUrl, cameraLayout]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, videoRef, videoUrl]);

  useEffect(() => {
    if (!selectedMarker) setFraming(false);
  }, [selectedMarker]);

  return (
    <div>
      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-line bg-black">
        {videoUrl ? (
          <div className={wide ? 'w-full' : 'h-full'} style={{ aspectRatio }}>
            <div className="relative h-full w-full overflow-hidden" data-testid="zoom-frame">
              <video ref={videoRef} src={videoUrl} playsInline className="absolute inset-0 h-full w-full" aria-label={label} />
              {cameraUrl && cameraLayout && (
                <video
                  ref={cameraRef}
                  src={cameraUrl}
                  muted
                  playsInline
                  aria-hidden
                  className="pointer-events-none absolute aspect-square -translate-x-1/2 -translate-y-1/2"
                  style={{ left: `${cameraLayout.x * 100}%`, top: `${cameraLayout.y * 100}%`, width: `${bubbleWidth}%` }}
                />
              )}
              <canvas
                ref={canvasRef}
                data-testid="zoom-canvas"
                aria-label="Preview with zoom effects"
                role="img"
                className="absolute inset-0 h-full w-full cursor-pointer"
                onClick={() => void togglePlay(videoRef)}
              />
              {framing && selectedMarker && (
                <FramingOverlay marker={selectedMarker} onCommit={(position) => onMarkerPositionChange(selectedMarker, position)} />
              )}
            </div>
          </div>
        ) : (
          <Loader2 size={24} aria-label="Loading video" className="animate-spin text-fg-subtle" />
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
        <IconButton icon={playing ? Pause : Play} label={playing ? 'Pause' : 'Play'} disabled={!videoUrl} onClick={() => void togglePlay(videoRef)} />
        <span className="font-mono text-xs text-fg-muted tabular-nums" data-testid="playhead">
          {formatTime(ms)} / {formatTime(duration)}
        </span>
        {showZoom && scale > 1.01 && (
          <span className="rounded-md bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">{scale.toFixed(1)}×</span>
        )}
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          Speed
          <select
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
            className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-xs text-fg"
          >
            {SPEEDS.map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-3">
          {selectedMarker && (
            <Button size="sm" variant={framing ? 'primary' : 'secondary'} icon={framing ? Check : Crop} onClick={() => setFraming(!framing)}>
              {framing ? 'Done' : 'Adjust framing'}
            </Button>
          )}
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={previewZoom}
              onChange={(event) => onPreviewZoomChange(event.target.checked)}
              className="size-4 accent-[var(--color-accent)]"
            />
            Preview zoom effects
          </label>
        </div>
      </div>
    </div>
  );
}

/**
 * Drag (or use the arrow keys) to move the selected effect's focus point. The rectangle is the part
 * of the frame that fills the video at full zoom, moved inwards at the edges exactly as rendered.
 */
function FramingOverlay({ marker, onCommit }: { marker: ZoomMarker; onCommit: (position: NormalizedPoint) => void }) {
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

async function togglePlay(ref: RefObject<HTMLVideoElement | null>) {
  const video = ref.current;
  if (!video) return;
  if (video.paused) await video.play().catch(() => undefined);
  else video.pause();
}
