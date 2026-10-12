/**
 * Zoom effects and the click interactions they are generated from.
 * Positions are normalised (0-1) relative to the captured content, so they stay valid at any
 * output resolution. Times are milliseconds on the recording timeline (pauses excluded).
 */

export interface NormalizedPoint {
  x: number;
  y: number;
}

export type ZoomEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'spring';

/** `zoom` magnifies around the position; `highlight` draws attention without magnifying. */
export type ZoomEffectType = 'zoom' | 'highlight';

/** `fixed` stays on `position`; `follow-cursor` pans to later clicks inside the marker. */
export type ZoomPositionMode = 'fixed' | 'follow-cursor';

export interface ZoomMarker {
  /** `zm_…`, unique. */
  id: string;
  /** Timeline time at which the effect is fully applied (the click, for automatic markers). */
  timeMs: number;
  position: NormalizedPoint;
  /** Zoom level, e.g. 2 = 200 %. */
  scale: number;
  /** How long the effect holds after `timeMs`. */
  durationMs: number;
  /** Transition length: easing in before `timeMs` and out after the hold. */
  transitionMs: number;
  positionMode: ZoomPositionMode;
  annotation?: string;
  effect: ZoomEffectType;
  enabled: boolean;
  /** `auto`: generated from a click. `manual`: added or edited by the user. */
  origin: 'auto' | 'manual';
  /** Clicks this automatic marker covers (several when quick successive clicks were merged). */
  sourceEventIds?: string[];
  createdAt: number;
  updatedAt: number;
}

export const ZOOM_LIMITS = {
  scale: { min: 1.1, max: 4 },
  durationMs: { min: 300, max: 20_000 },
  transitionMs: { min: 100, max: 2000 },
} as const;

export type TransitionSpeed = 'slow' | 'normal' | 'fast';

export const TRANSITION_MS: Record<TransitionSpeed, number> = { slow: 900, normal: 600, fast: 350 };

/** Defaults for markers in a project, also used by "Regenerate from clicks". */
export interface ZoomSettings {
  mode: 'auto' | 'manual' | 'off';
  defaultScale: number;
  durationMs: number;
  transitionMs: number;
  easing: ZoomEasing;
}

/** User preferences for automatic zoom (Settings). */
export interface AutoZoomSettings {
  /** Generate zoom markers from tracked clicks when a recording is saved. */
  enabled: boolean;
  /** Track clicks at all (only possible for the tab ZoomCapture was opened on). */
  trackClicks: boolean;
  scale: number;
  durationMs: number;
  transitionSpeed: TransitionSpeed;
}

/** A click captured in the recorded tab. Stored with the original recording, never edited. */
export interface InteractionEvent {
  /** `ev_…`, unique. */
  id: string;
  type: 'click';
  /** Recording timeline time. */
  timeMs: number;
  position: NormalizedPoint;
  /** 0 primary, 1 middle, 2 secondary. */
  button: number;
  /** CSS-pixel size of the captured viewport when it happened. */
  viewport: { width: number; height: number };
}

/** How clicks were (or were not) tracked for a recording. */
export interface ClickTrackingInfo {
  mode: 'tab' | 'unsupported';
  /** Why tracking was not available or stopped (shown to the user). */
  reason?: string;
  tabTitle?: string;
  origin?: string;
}
