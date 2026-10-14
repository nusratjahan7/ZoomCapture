import { placement } from './clipFrame';
import { cameraBubbleScale, type BackgroundStyle, type ClipTransform, type CameraLayout, type FontChoice, type FrameLayout, type SubtitleStyle, type TextClip, type TextSize } from '@/types';
import { drawBackground, type BackgroundImage } from './backgrounds';
import { cameraStyleOf } from './enhancements';
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
 * ratio or the recording is padded on a background). Zoom and the click/cursor overlays apply
 * inside `content`; text, subtitles and the camera bubble are placed relative to the whole frame.
 * Module 08: the background, the recording's rounded corners and shadow, camera styling, fonts,
 * opacity, callouts and subtitles; with their defaults a frame looks exactly as before.
 */

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface FrameImage {
  image: CanvasImageSource;
  width: number;
  height: number;
  /** Video-track layers: crop and placement in the frame (fitted and centred without one). */
  transform?: ClipTransform;
  /** 0-1 (a semi-transparent watermark); opaque when absent. */
  opacity?: number;
}

export interface FrameSources {
  /** Video-track layers, bottom first. */
  layers: Array<FrameImage | null>;
  camera?: FrameImage | null;
  cameraLayout?: CameraLayout;
  texts?: readonly TextClip[];
  /** Where the recording's picture sits in the frame; defaults to the whole frame. */
  content?: Rect;
  /** Behind everything (black when absent). */
  background?: { style: BackgroundStyle; image?: BackgroundImage | null };
  /** Rounded corners and shadow of the recording on the background. */
  frameLayout?: FrameLayout;
  /** Subtitle lines shown now, and how they look. */
  subtitles?: { lines: readonly string[]; style: SubtitleStyle };
}

/** Fonts available offline on every system (no web fonts are loaded). */
export const FONT_STACKS: Record<FontChoice, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Cascadia Code", Consolas, "SF Mono", Menlo, monospace',
  rounded: '"Segoe UI Rounded", "Arial Rounded MT Bold", "Nunito", system-ui, sans-serif',
  condensed: '"Arial Narrow", "Roboto Condensed", "Segoe UI", sans-serif',
};

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
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (sources.background && sources.background.style.kind !== 'none') {
    drawBackground(ctx, width, height, sources.background.style, sources.background.image);
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
  }

  // The recording's area: rounded corners and a shadow when it floats on a background.
  const layout = sources.frameLayout;
  const radius = Math.max(0, layout?.radius ?? 0) * Math.min(content.width, content.height);
  const contentPath = () => {
    ctx.beginPath();
    if (radius > 0.5) ctx.roundRect(content.x, content.y, content.width, content.height, radius);
    else ctx.rect(content.x, content.y, content.width, content.height);
  };
  if (layout && layout.shadow > 0) {
    const unit = Math.min(width, height);
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${(0.25 + 0.45 * layout.shadow).toFixed(3)})`;
    ctx.shadowBlur = unit * 0.06 * layout.shadow;
    ctx.shadowOffsetY = unit * 0.015 * layout.shadow;
    ctx.fillStyle = '#000';
    contentPath();
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  contentPath();
  ctx.clip();
  // The recording's own area is black under its layers (as letterbox bars were).
  ctx.fillStyle = '#000';
  ctx.fillRect(content.x, content.y, content.width, content.height);
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
  if (sources.subtitles && sources.subtitles.style.visible && sources.subtitles.lines.length) drawSubtitles(ctx, width, height, sources.subtitles.lines, sources.subtitles.style);
  ctx.restore();
}

/**
 * One video layer, fitted inside the content area ("contain") and seen through the zoom camera.
 * A layer with the content's own shape (the screen recording) is drawn as a source crop.
 */
function drawLayer(ctx: Context2D, content: Rect, layer: FrameImage, state: FrameState) {
  if (layer.opacity !== undefined && layer.opacity < 1) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, layer.opacity);
    drawLayer(ctx, content, { ...layer, opacity: undefined }, state);
    ctx.restore();
    return;
  }
  const { scale, offsetX, offsetY } = state.camera;
  if (layer.transform) {
    // Cropped and placed by the user (see clipFrame.ts), then through the camera.
    const p = placement(layer, content.width / content.height, layer.transform);
    ctx.drawImage(
      layer.image,
      p.sx,
      p.sy,
      p.sw,
      p.sh,
      content.x + (p.x * scale - offsetX) * content.width,
      content.y + (p.y * scale - offsetY) * content.height,
      p.width * scale * content.width,
      p.height * scale * content.height,
    );
    return;
  }
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
/**
 * Where a text clip is drawn in a frame: its font size, wrapped lines and box (centre `cx`, `cy`),
 * kept inside the frame. Also used by the preview's drag handle, so it outlines the text exactly.
 * Sets `ctx.font` to the clip's font.
 */
export function textLayout(ctx: Pick<Context2D, 'font' | 'measureText'>, width: number, height: number, clip: TextClip) {
  const fontSize = Math.max(10, Math.round(Math.min(width, height) * TEXT_SIZE[clip.style.size]));
  ctx.font = `700 ${fontSize}px ${FONT_STACKS[clip.style.font ?? 'system']}`;
  const lines = wrapText(ctx as Context2D, clip.text.trim(), width * 0.8);
  const lineHeight = fontSize * 1.25;
  const padX = fontSize * 0.6;
  const padY = fontSize * 0.35;
  const boxWidth = Math.max(...lines.map((line) => ctx.measureText(line).width)) + padX * 2;
  const boxHeight = lines.length * lineHeight + padY * 2;
  const cx = Math.min(width - boxWidth / 2, Math.max(boxWidth / 2, clip.position.x * width));
  const cy = Math.min(height - boxHeight / 2, Math.max(boxHeight / 2, clip.position.y * height));
  return { fontSize, lines, lineHeight, padY, boxWidth, boxHeight, cx, cy };
}

function drawText(ctx: Context2D, width: number, height: number, clip: TextClip) {
  if (!clip.text.trim()) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, clip.style.opacity ?? 1));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const { fontSize, lines, lineHeight, padY, boxWidth, boxHeight, cx, cy } = textLayout(ctx, width, height, clip);
  if (clip.callout) drawCalloutArrow(ctx, { x: cx, y: cy, width: boxWidth, height: boxHeight }, { x: clip.callout.target.x * width, y: clip.callout.target.y * height }, fontSize, clip.style.color);
  if (clip.style.background) {
    ctx.fillStyle = clip.style.backgroundColor ?? OVERLAY_STYLE.annotationBackground;
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

/** An arrow from the edge of a text box (centre `box.x/y`) to a point it calls out. */
function drawCalloutArrow(ctx: Context2D, box: { x: number; y: number; width: number; height: number }, target: { x: number; y: number }, fontSize: number, colour: string) {
  const dx = target.x - box.x;
  const dy = target.y - box.y;
  if (Math.abs(dx) < box.width / 2 && Math.abs(dy) < box.height / 2) return; // The target is under the box.
  // Leave the box where the line to the target crosses its edge.
  const scale = Math.min(Math.abs(box.width / 2 / (dx || 1e-6)), Math.abs(box.height / 2 / (dy || 1e-6)));
  const startX = box.x + dx * scale;
  const startY = box.y + dy * scale;
  const angle = Math.atan2(target.y - startY, target.x - startX);
  const head = fontSize * 0.55;
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = Math.max(2, fontSize * 0.12);
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = fontSize * 0.2;
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(target.x - Math.cos(angle) * head * 0.8, target.y - Math.sin(angle) * head * 0.8);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(target.x, target.y);
  ctx.lineTo(target.x - Math.cos(angle - 0.45) * head, target.y - Math.sin(angle - 0.45) * head);
  ctx.lineTo(target.x - Math.cos(angle + 0.45) * head, target.y - Math.sin(angle + 0.45) * head);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Subtitles: centred lines (explicit breaks kept, long lines wrapped) on an optional box. */
function drawSubtitles(ctx: Context2D, width: number, height: number, cues: readonly string[], style: SubtitleStyle) {
  const fontSize = Math.max(10, Math.round(Math.min(width, height) * style.size));
  ctx.save();
  ctx.font = `600 ${fontSize}px ${FONT_STACKS[style.font]}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = cues.flatMap((cue) => wrapText(ctx, cue.trim(), width * 0.9)).filter((line) => line.length > 0).slice(0, 4);
  if (!lines.length) return ctx.restore();
  const lineHeight = fontSize * 1.3;
  const padX = fontSize * 0.5;
  const padY = fontSize * 0.25;
  const blockHeight = lines.length * lineHeight;
  const margin = style.margin * height;
  const top =
    style.position === 'top' ? margin + padY : style.position === 'middle' ? (height - blockHeight) / 2 : height - margin - padY - blockHeight;
  lines.forEach((line, index) => {
    const y = top + lineHeight * (index + 0.5);
    if (style.background) {
      const lineWidth = ctx.measureText(line).width + padX * 2;
      ctx.save();
      ctx.globalAlpha = Math.min(1, Math.max(0, style.backgroundOpacity));
      ctx.fillStyle = style.background;
      ctx.beginPath();
      ctx.roundRect(width / 2 - lineWidth / 2, y - lineHeight / 2, lineWidth, lineHeight, fontSize * 0.2);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
      ctx.shadowBlur = fontSize * 0.25;
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, width / 2, y);
  });
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

/**
 * The camera bubble: a circle or rounded rectangle, mirrored, with an optional border, shadow and
 * coloured ring around the picture. Always kept fully inside the frame. Not affected by zoom.
 */
function drawCameraBubble(ctx: Context2D, width: number, height: number, camera: FrameImage, layout: CameraLayout) {
  const style = cameraStyleOf(layout);
  const bubbleWidth = cameraBubbleScale(layout) * width;
  const bubbleHeight = bubbleWidth / style.aspect;
  const cx = Math.min(width - bubbleWidth / 2, Math.max(bubbleWidth / 2, layout.x * width));
  const cy = Math.min(height - bubbleHeight / 2, Math.max(bubbleHeight / 2, layout.y * height));
  const shape = (inset: number) => {
    const w = bubbleWidth - inset * 2;
    const h = bubbleHeight - inset * 2;
    ctx.beginPath();
    if (style.shape === 'circle') ctx.arc(cx, cy, w / 2, 0, Math.PI * 2);
    else ctx.roundRect(cx - w / 2, cy - h / 2, w, h, style.radius * Math.min(w, h));
  };
  if (style.shadow > 0 || style.background) {
    ctx.save();
    if (style.shadow > 0) {
      ctx.shadowColor = `rgba(0, 0, 0, ${(0.3 + 0.4 * style.shadow).toFixed(3)})`;
      ctx.shadowBlur = bubbleWidth * 0.15 * style.shadow;
      ctx.shadowOffsetY = bubbleWidth * 0.03 * style.shadow;
    }
    ctx.fillStyle = style.background ?? '#000';
    shape(0);
    ctx.fill();
    ctx.restore();
  }
  // The picture, inside the ring (if any), cropped to the bubble's shape and mirrored.
  const inset = style.background ? style.padding * bubbleWidth : 0;
  const pictureWidth = bubbleWidth - inset * 2;
  const pictureHeight = bubbleHeight - inset * 2;
  const sourceAspect = pictureWidth / pictureHeight;
  const sw = Math.min(camera.width, camera.height * sourceAspect);
  const sh = sw / sourceAspect;
  ctx.save();
  shape(inset);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.scale(-1, 1);
  ctx.drawImage(camera.image, (camera.width - sw) / 2, (camera.height - sh) / 2, sw, sh, -pictureWidth / 2, -pictureHeight / 2, pictureWidth, pictureHeight);
  ctx.restore();
  if (style.borderWidth > 0) {
    const lineWidth = Math.max(1, style.borderWidth * bubbleWidth);
    ctx.save();
    ctx.strokeStyle = style.borderColor;
    ctx.lineWidth = lineWidth;
    shape(lineWidth / 2);
    ctx.stroke();
    ctx.restore();
  }
}
