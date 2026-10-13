import { CAMERA_BUBBLE_SCALE, type CameraLayout, type TextClip, type TextSize } from '@/types';
import { sourceCrop } from './camera';
import type { Rect } from './compose';
import type { FrameState } from './frameState';

/**
 * Draws one output frame: the zoomed video layers, effect overlays, text annotations and the
 * camera bubble. Used unchanged by the editor preview (HTML canvas, from <video> elements) and
 * the rendered video (OffscreenCanvas, from decoded frames). All sizes are relative to the output
 * frame, so the preview at any size looks like a scaled copy of the rendered video.
 *
 * The recording's picture fills `content` (the whole frame unless the output has another aspect
 * ratio, then it is letterboxed). Zoom and the click/cursor overlays apply inside `content`; text
 * and the camera bubble are placed relative to the whole frame.
 */

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface FrameImage {
  image: CanvasImageSource;
  width: number;
  height: number;
}

export interface FrameSources {
  /** Video-track layers, bottom first. */
  layers: Array<FrameImage | null>;
  camera?: FrameImage | null;
  cameraLayout?: CameraLayout;
  texts?: readonly TextClip[];
  /** Where the recording's picture sits in the frame; defaults to the whole frame. */
  content?: Rect;
}

export const OVERLAY_STYLE = {
  highlight: '#fbbf24',
  ripple: '#ffffff',
  rippleFill: 'rgba(124, 92, 255, 0.35)',
  cursor: 'rgba(251, 191, 36, 0.38)',
  annotationBackground: 'rgba(10, 12, 18, 0.78)',
  annotationText: '#ffffff',
} as const;

export const TEXT_SIZE: Record<TextSize, number> = { small: 0.04, medium: 0.06, large: 0.09 };

export function drawFrame(ctx: Context2D, width: number, height: number, sources: FrameSources, state: FrameState): void {
  const content = sources.content ?? { x: 0, y: 0, width, height };
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.save();
  ctx.beginPath();
  ctx.rect(content.x, content.y, content.width, content.height);
  ctx.clip();
  for (const layer of sources.layers) if (layer) drawLayer(ctx, content, layer, state);
  ctx.restore();

  // Overlays live in the content's coordinates (they follow the zoomed picture).
  ctx.save();
  ctx.translate(content.x, content.y);
  const cw = content.width;
  const ch = content.height;
  const unit = Math.min(cw, ch);
  if (state.highlight) drawHighlight(ctx, cw, ch, unit, state.highlight);
  for (const ripple of state.ripples) drawRipple(ctx, cw, ch, unit, ripple);
  if (state.cursor) {
    ctx.fillStyle = OVERLAY_STYLE.cursor;
    ctx.beginPath();
    ctx.arc(state.cursor.x * cw, state.cursor.y * ch, unit * 0.035, 0, Math.PI * 2);
    ctx.fill();
  }
  if (state.annotation) drawAnnotation(ctx, cw, ch, unit, state.annotation);
  ctx.restore();

  for (const text of sources.texts ?? []) drawText(ctx, width, height, text);
  if (sources.camera && sources.cameraLayout) drawCameraBubble(ctx, width, height, sources.camera, sources.cameraLayout);
  ctx.restore();
}

/**
 * One video layer, fitted inside the content area ("contain") and seen through the zoom camera.
 * A layer with the content's own shape (the screen recording) is drawn as a source crop.
 */
function drawLayer(ctx: Context2D, content: Rect, layer: FrameImage, state: FrameState) {
  const { scale, offsetX, offsetY } = state.camera;
  const fit = Math.min(content.width / layer.width, content.height / layer.height);
  const w = (layer.width * fit) / content.width;
  const h = (layer.height * fit) / content.height;
  if (Math.abs(w - 1) < 1e-3 && Math.abs(h - 1) < 1e-3) {
    const { sx, sy, sw, sh } = sourceCrop(state.camera, layer);
    ctx.drawImage(layer.image, sx, sy, sw, sh, content.x, content.y, content.width, content.height);
    return;
  }
  // Normalised rect of the layer in the content, then through the camera (u = p · scale − offset).
  const x = (1 - w) / 2;
  const y = (1 - h) / 2;
  ctx.drawImage(
    layer.image,
    content.x + (x * scale - offsetX) * content.width,
    content.y + (y * scale - offsetY) * content.height,
    w * scale * content.width,
    h * scale * content.height,
  );
}

/** A text annotation centred on its position, wrapped to at most 80 % of the frame width. */
function drawText(ctx: Context2D, width: number, height: number, clip: TextClip) {
  const text = clip.text.trim();
  if (!text) return;
  const fontSize = Math.max(10, Math.round(Math.min(width, height) * TEXT_SIZE[clip.style.size]));
  ctx.save();
  ctx.font = `700 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapText(ctx, text, width * 0.8);
  const lineHeight = fontSize * 1.25;
  const padX = fontSize * 0.6;
  const padY = fontSize * 0.35;
  const boxWidth = Math.max(...lines.map((line) => ctx.measureText(line).width)) + padX * 2;
  const boxHeight = lines.length * lineHeight + padY * 2;
  const cx = Math.min(width - boxWidth / 2, Math.max(boxWidth / 2, clip.position.x * width));
  const cy = Math.min(height - boxHeight / 2, Math.max(boxHeight / 2, clip.position.y * height));
  if (clip.style.background) {
    ctx.fillStyle = OVERLAY_STYLE.annotationBackground;
    ctx.beginPath();
    ctx.roundRect(cx - boxWidth / 2, cy - boxHeight / 2, boxWidth, boxHeight, fontSize * 0.35);
    ctx.fill();
  } else {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
    ctx.shadowBlur = fontSize * 0.25;
  }
  ctx.fillStyle = clip.style.color;
  lines.forEach((line, index) => ctx.fillText(line, cx, cy - boxHeight / 2 + padY + lineHeight * (index + 0.5)));
  ctx.restore();
}

/** Greedy word wrap; explicit line breaks are kept. Very long words are left to overflow. */
function wrapText(ctx: Context2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines.slice(0, 6);
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
