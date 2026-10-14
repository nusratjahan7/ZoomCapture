/**
 * Backgrounds behind the recording: solid colours, gradients, a library of presets drawn in code
 * (no image files to ship or download), and imported images with fit, position and blur. The same
 * functions draw the preview, the export and the preset thumbnails, so they always match.
 */
import type { BackgroundStyle } from '@/types';

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface BackgroundImage {
  image: CanvasImageSource;
  width: number;
  height: number;
}

interface Preset {
  id: string;
  label: string;
  draw: (ctx: Context2D, width: number, height: number) => void;
}

function linear(ctx: Context2D, width: number, height: number, angle: number, stops: Array<[number, string]>) {
  const radians = ((angle - 90) * Math.PI) / 180;
  const half = (Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians))) / 2;
  const cx = width / 2;
  const cy = height / 2;
  const gradient = ctx.createLinearGradient(cx - Math.cos(radians) * half, cy - Math.sin(radians) * half, cx + Math.cos(radians) * half, cy + Math.sin(radians) * half);
  for (const [offset, colour] of stops) gradient.addColorStop(offset, colour);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

/** Soft coloured light: radial gradients over a base colour. */
function glow(ctx: Context2D, width: number, height: number, base: string, spots: Array<[number, number, number, string]>) {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);
  const unit = Math.max(width, height);
  for (const [x, y, r, colour] of spots) {
    const gradient = ctx.createRadialGradient(x * width, y * height, 0, x * width, y * height, r * unit);
    gradient.addColorStop(0, colour);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
}

export const BACKGROUND_PRESETS: readonly Preset[] = [
  { id: 'aurora', label: 'Aurora', draw: (c, w, h) => glow(c, w, h, '#0b1026', [[0.15, 0.2, 0.7, 'rgba(124,92,255,0.85)'], [0.85, 0.3, 0.6, 'rgba(34,211,238,0.7)'], [0.5, 1, 0.7, 'rgba(236,72,153,0.55)']]) },
  { id: 'sunset', label: 'Sunset', draw: (c, w, h) => linear(c, w, h, 160, [[0, '#ff7e5f'], [0.55, '#feb47b'], [1, '#6a3093']]) },
  { id: 'ocean', label: 'Ocean', draw: (c, w, h) => linear(c, w, h, 135, [[0, '#0f2027'], [0.5, '#203a43'], [1, '#2c7da0']]) },
  { id: 'mint', label: 'Mint', draw: (c, w, h) => glow(c, w, h, '#d9f99d', [[0.2, 0.8, 0.8, 'rgba(45,212,191,0.8)'], [0.9, 0.1, 0.6, 'rgba(250,250,250,0.7)']]) },
  { id: 'candy', label: 'Candy', draw: (c, w, h) => linear(c, w, h, 120, [[0, '#f9a8d4'], [0.5, '#c4b5fd'], [1, '#93c5fd']]) },
  { id: 'midnight', label: 'Midnight', draw: (c, w, h) => glow(c, w, h, '#020617', [[0.5, 0.5, 0.75, 'rgba(30,64,175,0.6)'], [0.1, 0.9, 0.4, 'rgba(124,58,237,0.5)']]) },
  { id: 'ember', label: 'Ember', draw: (c, w, h) => glow(c, w, h, '#1c0a00', [[0.8, 0.85, 0.8, 'rgba(234,88,12,0.85)'], [0.2, 0.1, 0.5, 'rgba(250,204,21,0.45)']]) },
  { id: 'graphite', label: 'Graphite', draw: (c, w, h) => linear(c, w, h, 180, [[0, '#3f3f46'], [1, '#18181b']]) },
  {
    id: 'dots',
    label: 'Dots',
    draw: (c, w, h) => {
      c.fillStyle = '#f8fafc';
      c.fillRect(0, 0, w, h);
      const step = Math.max(8, Math.min(w, h) / 24);
      c.fillStyle = 'rgba(100,116,139,0.35)';
      for (let y = step / 2; y < h; y += step) {
        for (let x = step / 2; x < w; x += step) {
          c.beginPath();
          c.arc(x, y, step * 0.09, 0, Math.PI * 2);
          c.fill();
        }
      }
    },
  },
  {
    id: 'grid',
    label: 'Grid',
    draw: (c, w, h) => {
      linear(c, w, h, 135, [[0, '#111827'], [1, '#1f2937']]);
      const step = Math.max(8, Math.min(w, h) / 14);
      c.strokeStyle = 'rgba(148,163,184,0.15)';
      c.lineWidth = Math.max(1, step / 40);
      c.beginPath();
      for (let x = 0; x <= w; x += step) {
        c.moveTo(x, 0);
        c.lineTo(x, h);
      }
      for (let y = 0; y <= h; y += step) {
        c.moveTo(0, y);
        c.lineTo(w, y);
      }
      c.stroke();
    },
  },
];

export const presetById = (id: string | undefined) => BACKGROUND_PRESETS.find((preset) => preset.id === id);

/** Fills the whole frame with the background (black when there is none, as before Module 08). */
export function drawBackground(ctx: Context2D, width: number, height: number, style: BackgroundStyle, image?: BackgroundImage | null): void {
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  switch (style.kind) {
    case 'color':
      ctx.fillStyle = style.color;
      ctx.fillRect(0, 0, width, height);
      break;
    case 'gradient':
      linear(ctx, width, height, style.gradient.angle, [
        [0, style.gradient.from],
        [1, style.gradient.to],
      ]);
      break;
    case 'preset':
      (presetById(style.presetId) ?? BACKGROUND_PRESETS[0]!).draw(ctx, width, height);
      break;
    case 'image':
      ctx.fillStyle = style.color;
      ctx.fillRect(0, 0, width, height);
      if (image && image.width > 0 && image.height > 0) drawImageBackground(ctx, width, height, style, image);
      break;
    default:
      break;
  }
  ctx.restore();
}

function drawImageBackground(ctx: Context2D, width: number, height: number, style: BackgroundStyle, image: BackgroundImage) {
  const blur = Math.max(0, style.blur) * Math.min(width, height);
  if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;
  // A blurred image is drawn a little larger, so its edges don't fade to the colour beneath.
  const bleed = blur * 2;
  if (style.fit === 'tile') {
    const tileWidth = Math.max(16, Math.min(width, height) / 4);
    const tileHeight = (tileWidth * image.height) / image.width;
    for (let y = -bleed; y < height + bleed; y += tileHeight) {
      for (let x = -bleed; x < width + bleed; x += tileWidth) ctx.drawImage(image.image, x, y, tileWidth, tileHeight);
    }
    ctx.filter = 'none';
    return;
  }
  let drawWidth = width + bleed * 2;
  let drawHeight = height + bleed * 2;
  if (style.fit !== 'stretch') {
    const scale = (style.fit === 'cover' ? Math.max : Math.min)(drawWidth / image.width, drawHeight / image.height);
    drawWidth = image.width * scale;
    drawHeight = image.height * scale;
  }
  // `position` picks which part stays in view (cover) or where the picture sits (contain).
  const x = -bleed + (width + bleed * 2 - drawWidth) * style.position.x;
  const y = -bleed + (height + bleed * 2 - drawHeight) * style.position.y;
  ctx.drawImage(image.image, x, y, drawWidth, drawHeight);
  ctx.filter = 'none';
}
