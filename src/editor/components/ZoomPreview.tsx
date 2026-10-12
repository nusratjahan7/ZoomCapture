import { useEffect, useState, type RefObject } from 'react';
import { Loader2, Pause, Play } from 'lucide-react';
import { zoomTransformOrigin } from '@/services/zoom/coordinates';
import { zoomStateAt } from '@/services/zoom/markers';
import { IconButton } from '@/shared/components';
import { CAMERA_BUBBLE_SCALE, type CameraLayout, type InteractionEvent, type ZoomMarker } from '@/types';

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
    const events = ['seeked', 'pause', 'ended', 'loadedmetadata', 'timeupdate'] as const;
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

/**
 * Plays the recording with zoom effects applied live (CSS transform around the clamped focus),
 * highlight rings and annotations. The final render happens at export; this is a faithful preview
 * of the marker data. The frame keeps the recording's aspect ratio so positions line up.
 */
export function ZoomPreview({
  videoUrl,
  cameraUrl,
  cameraLayout,
  aspectRatio,
  markers,
  interactions,
  selectedMarker,
  previewZoom,
  onPreviewZoomChange,
  videoRef,
  cameraRef,
  label,
}: {
  videoUrl: string | null;
  cameraUrl: string | null;
  cameraLayout?: CameraLayout;
  aspectRatio: number;
  markers: ZoomMarker[];
  interactions: InteractionEvent[];
  selectedMarker: ZoomMarker | null;
  previewZoom: boolean;
  onPreviewZoomChange: (on: boolean) => void;
  videoRef: RefObject<HTMLVideoElement | null>;
  cameraRef: RefObject<HTMLVideoElement | null>;
  label: string;
}) {
  const { ms, playing } = useVideoTime(videoRef, Boolean(videoUrl));
  const duration = (videoRef.current?.duration ?? 0) * 1000;
  const state = zoomStateAt(previewZoom ? markers : [], ms, interactions);
  const origin = zoomTransformOrigin(state.focus, state.scale);
  const wide = aspectRatio >= 16 / 9;
  const bubbleWidth = cameraLayout ? CAMERA_BUBBLE_SCALE[cameraLayout.size] * 100 : 0;

  return (
    <div>
      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-line bg-black">
        {videoUrl ? (
          <div className={wide ? 'w-full' : 'h-full'} style={{ aspectRatio }}>
            <div className="relative h-full w-full overflow-hidden" data-testid="zoom-frame">
              <div
                className="h-full w-full will-change-transform"
                data-testid="zoom-layer"
                data-scale={state.scale.toFixed(3)}
                style={{ transform: `scale(${state.scale})`, transformOrigin: `${origin.x * 100}% ${origin.y * 100}%` }}
              >
                <video ref={videoRef} src={videoUrl} playsInline className="h-full w-full" aria-label={label} onClick={() => void togglePlay(videoRef)} />
              </div>

              {state.marker?.effect === 'highlight' && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute size-16 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-warning shadow-[0_0_0_9999px_rgb(0_0_0/0.35)]"
                  style={{ left: `${state.focus.x * 100}%`, top: `${state.focus.y * 100}%`, opacity: state.strength }}
                />
              )}
              {state.marker?.annotation && (
                <span
                  className="pointer-events-none absolute top-3 left-1/2 max-w-[80%] -translate-x-1/2 rounded-lg bg-black/75 px-3 py-1.5 text-sm font-medium text-white"
                  style={{ opacity: state.strength }}
                >
                  {state.marker.annotation}
                </span>
              )}
              {selectedMarker && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent-2 bg-accent-2/25"
                  style={{ left: `${selectedMarker.position.x * 100}%`, top: `${selectedMarker.position.y * 100}%` }}
                />
              )}
              {cameraUrl && cameraLayout && (
                <video
                  ref={cameraRef}
                  src={cameraUrl}
                  muted
                  playsInline
                  aria-hidden
                  className="pointer-events-none absolute aspect-square -translate-x-1/2 -translate-y-1/2 -scale-x-100 rounded-full border-2 border-white/80 object-cover"
                  style={{ left: `${cameraLayout.x * 100}%`, top: `${cameraLayout.y * 100}%`, width: `${bubbleWidth}%` }}
                />
              )}
            </div>
          </div>
        ) : (
          <Loader2 size={24} aria-label="Loading video" className="animate-spin text-fg-subtle" />
        )}
      </div>

      <div className="mt-2 flex items-center gap-3 px-1">
        <IconButton icon={playing ? Pause : Play} label={playing ? 'Pause' : 'Play'} disabled={!videoUrl} onClick={() => void togglePlay(videoRef)} />
        <span className="font-mono text-xs text-fg-muted tabular-nums" data-testid="playhead">
          {formatTime(ms)} / {formatTime(duration)}
        </span>
        {state.scale > 1.001 && <span className="rounded-md bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">{state.scale.toFixed(1)}×</span>}
        <label className="ml-auto flex items-center gap-2 text-xs text-fg-muted">
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
  );
}

async function togglePlay(ref: RefObject<HTMLVideoElement | null>) {
  const video = ref.current;
  if (!video) return;
  if (video.paused) await video.play().catch(() => undefined);
  else video.pause();
}
