import { CAMERA_BUBBLE_SCALE, type CameraLayout } from '@/types';
import { sourceCrop } from './camera';
import type { FrameState } from './frameState';

/**
 * Draws one output frame: the zoomed source, effect overlays and the camera bubble.
 * Used unchanged by the editor preview (HTML canvas, from a <video>) and the rendered video
 * (OffscreenCanvas, from decoded frames). All sizes are relative to the output frame, so the
 * preview at any size looks like a scaled copy of the rendered video.
 */

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface FrameImage {
  image: CanvasImageSource;
  width: number;
  height: number;
}

export interface FrameSources {
  screen: FrameImage | null;
  camera?: FrameImage | null;
  cameraLayout?: CameraLayout;
}

export const OVERLAY_STYLE = {
  highlight: '#fbbf24',
  ripple: '#ffffff',
  rippleFill: 'rgba(124, 92, 255, 0.35)',
  cursor: 'rgba(251, 191, 36, 0.38)',
  annotationBackground: 'rgba(10, 12, 18, 0.78)',
  annotationText: '#ffffff',
} as const;

export function drawFrame(ctx: Context2D, width: number, height: number, sources: FrameSources, state: FrameState): void {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  if (sources.screen) {
    const { sx, sy, sw, sh } = sourceCrop(state.camera, sources.screen);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sources.screen.image, sx, sy, sw, sh, 0, 0, width, height);
  }
  const unit = Math.min(width, height);

  if (state.highlight) drawHighlight(ctx, width, height, unit, state.highlight);
  for (const ripple of state.ripples) drawRipple(ctx, width, height, unit, ripple);
  if (state.cursor) {
    ctx.fillStyle = OVERLAY_STYLE.cursor;
    ctx.beginPath();
    ctx.arc(state.cursor.x * width, state.cursor.y * height, unit * 0.035, 0, Math.PI * 2);
    ctx.fill();
  }
  if (state.annotation) drawAnnotation(ctx, width, height, unit, state.annotation);
  if (sources.camera && sources.cameraLayout) drawCameraBubble(ctx, width, height, sources.camera, sources.cameraLayout);
  ctx.restore();
}

function drawHighlight(ctx: Context2D, width: number, height: number, unit: number, highlight: NonNullable<FrameState['highlight']>) {
  const x = highlight.point.x * width;
  const y = highlight.point.y * height;
  const radius = unit * 0.07;
  ctx.save();
  ctx.globalAlpha = highlight.strength;
  // Dim everything except a circle around the point.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.arc(x, y, radius, 0, Math.PI * 2, true);
  ctx.fill('evenodd');
  ctx.strokeStyle = OVERLAY_STYLE.highlight;
  ctx.lineWidth = Math.max(2, unit * 0.008);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawRipple(ctx: Context2D, width: number, height: number, unit: number, ripple: FrameState['ripples'][number]) {
  const eased = 1 - (1 - ripple.progress) ** 3;
  const radius = unit * (0.012 + 0.045 * eased);
  ctx.save();
  ctx.globalAlpha = 1 - ripple.progress;
  ctx.fillStyle = OVERLAY_STYLE.rippleFill;
  ctx.strokeStyle = OVERLAY_STYLE.ripple;
  ctx.lineWidth = Math.max(1.5, unit * 0.005);
  ctx.beginPath();
  ctx.arc(ripple.point.x * width, ripple.point.y * height, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawAnnotation(ctx: Context2D, width: number, height: number, unit: number, annotation: NonNullable<FrameState['annotation']>) {
  const fontSize = Math.max(10, Math.round(unit * 0.04));
  const padX = fontSize * 0.75;
  const padY = fontSize * 0.45;
  ctx.save();
  ctx.globalAlpha = annotation.opacity;
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const text = fitText(ctx, annotation.text, width * 0.8 - padX * 2);
  const boxWidth = ctx.measureText(text).width + padX * 2;
  const boxHeight = fontSize + padY * 2;
  const x = (width - boxWidth) / 2;
  const y = height * 0.04;
  ctx.fillStyle = OVERLAY_STYLE.annotationBackground;
  ctx.beginPath();
  ctx.roundRect(x, y, boxWidth, boxHeight, fontSize * 0.4);
  ctx.fill();
  ctx.fillStyle = OVERLAY_STYLE.annotationText;
  ctx.fillText(text, width / 2, y + boxHeight / 2);
  ctx.restore();
}

/** Shortens text with an ellipsis until it fits `maxWidth`. */
function fitText(ctx: Context2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low).trimEnd()}…`;
}

/** Round, mirrored camera bubble, as placed during recording. Not affected by zoom. */
function drawCameraBubble(ctx: Context2D, width: number, height: number, camera: FrameImage, layout: CameraLayout) {
  const diameter = CAMERA_BUBBLE_SCALE[layout.size] * width;
  const cx = layout.x * width;
  const cy = layout.y * height;
  const side = Math.min(camera.width, camera.height);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, diameter / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.scale(-1, 1);
  ctx.drawImage(camera.image, (camera.width - side) / 2, (camera.height - side) / 2, side, side, -diameter / 2, -diameter / 2, diameter, diameter);
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = Math.max(1.5, width * 0.002);
  ctx.beginPath();
  ctx.arc(cx, cy, diameter / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
