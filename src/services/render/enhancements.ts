/**
 * Module 08 enhancement settings: defaults for projects that don't have them yet (so older
 * projects look exactly as before), and the layout geometry they imply. Used by the editor, the
 * preview and the export alike.
 */
import type { BackgroundStyle, CameraLayout, CustomSize, FrameLayout, Project, SubtitleCue, SubtitleStyle } from '@/types';
import type { Rect } from './compose';

interface Size {
  width: number;
  height: number;
}

export const DEFAULT_BACKGROUND: BackgroundStyle = {
  kind: 'none',
  color: '#1e1b4b',
  gradient: { from: '#7c5cff', to: '#22d3ee', angle: 135 },
  fit: 'cover',
  position: { x: 0.5, y: 0.5 },
  blur: 0,
};

export const DEFAULT_FRAME_LAYOUT: FrameLayout = { padding: 0, radius: 0, shadow: 0 };

/** Ready-made layouts for the recording on its background. */
export const FRAME_LAYOUT_PRESETS: ReadonlyArray<{ id: string; label: string; layout: FrameLayout }> = [
  { id: 'fill', label: 'Fill', layout: { padding: 0, radius: 0, shadow: 0 } },
  { id: 'padded', label: 'Padded', layout: { padding: 0.06, radius: 0.02, shadow: 0.4 } },
  { id: 'floating', label: 'Floating', layout: { padding: 0.1, radius: 0.04, shadow: 0.8 } },
  { id: 'spotlight', label: 'Spotlight', layout: { padding: 0.16, radius: 0.06, shadow: 1 } },
];

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  visible: true,
  font: 'system',
  size: 0.05,
  color: '#ffffff',
  background: '#000000',
  backgroundOpacity: 0.6,
  position: 'bottom',
  margin: 0.06,
};

export const LIMITS = {
  padding: { min: 0, max: 0.3 },
  radius: { min: 0, max: 0.2 },
  blur: { min: 0, max: 0.05 },
  subtitleSize: { min: 0.025, max: 0.12 },
  customSide: { min: 128, max: 4096 },
} as const;

export const backgroundOf = (project: Pick<Project, 'background'>): BackgroundStyle => ({ ...DEFAULT_BACKGROUND, ...project.background });
export const frameLayoutOf = (project: Pick<Project, 'frameLayout'>): FrameLayout => ({ ...DEFAULT_FRAME_LAYOUT, ...project.frameLayout });
export const subtitleStyleOf = (project: Pick<Project, 'subtitleStyle'>): SubtitleStyle => ({ ...DEFAULT_SUBTITLE_STYLE, ...project.subtitleStyle });

/** Every camera style setting, with defaults (a circle with a thin white border). */
export function cameraStyleOf(layout: CameraLayout) {
  return {
    shape: layout.shape ?? 'circle',
    aspect: layout.shape === 'rounded' ? Math.min(2, Math.max(0.5, layout.aspect ?? 4 / 3)) : 1,
    radius: Math.min(0.5, Math.max(0, layout.radius ?? 0.18)),
    borderWidth: Math.min(0.1, Math.max(0, layout.borderWidth ?? 0.012)),
    borderColor: layout.borderColor ?? 'rgba(255, 255, 255, 0.8)',
    shadow: Math.min(1, Math.max(0, layout.shadow ?? 0)),
    background: layout.background ?? null,
    padding: Math.min(0.15, Math.max(0, layout.padding ?? 0)),
  };
}

const clampSide = (value: number) => Math.round(Math.min(LIMITS.customSide.max, Math.max(LIMITS.customSide.min, value)));

/** Valid custom dimensions (even numbers, within limits). */
export function clampCustomSize(size: CustomSize): CustomSize {
  const even = (value: number) => Math.round(clampSide(value) / 2) * 2;
  return { width: even(size.width), height: even(size.height) };
}

/**
 * Where the recording is drawn in a frame: inside the padding, as large as possible keeping its
 * shape, centred. With no padding this is the plain letterboxed content area.
 */
export function layoutRect(frame: Size, source: Size, layout: FrameLayout = DEFAULT_FRAME_LAYOUT): Rect {
  const inset = Math.min(LIMITS.padding.max, Math.max(0, layout.padding)) * Math.min(frame.width, frame.height);
  const area = { width: Math.max(1, frame.width - inset * 2), height: Math.max(1, frame.height - inset * 2) };
  const scale = Math.min(area.width / source.width, area.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return { x: (frame.width - width) / 2, y: (frame.height - height) / 2, width, height };
}

/** The cues shown at a time (end exclusive), from every subtitle track. */
export function activeCues(project: Pick<Project, 'subtitles'>, timeMs: number): SubtitleCue[] {
  return project.subtitles.flatMap((track) => track.cues.filter((cue) => timeMs >= cue.startMs && timeMs < cue.endMs));
}
