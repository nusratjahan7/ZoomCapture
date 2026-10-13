import type { CaptureTarget, SelectedSurface } from '@/types';

/**
 * Pages where Chrome never lets extensions run scripts (browser UI, other extensions, the Web
 * Store). Recording them works; tracking clicks does not.
 */
export function isTrackableUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  if (host === 'chromewebstore.google.com') return false;
  if (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) return false;
  return true;
}

/**
 * `tab`: the tab ZoomCapture was opened on (positions relative to its viewport).
 * `screen`: the entire screen; clicks are observed in Chrome tabs on it (positions relative to
 * the screen). Clicks in other applications can't be seen by an extension.
 */
export type TrackingScope = 'tab' | 'screen';

export type TrackingSupport = { supported: true; scope: TrackingScope } | { supported: false; reason: string };

export interface TrackingSupportInput {
  /** Click tracking enabled in Settings. */
  trackClicks: boolean;
  /** What is actually being captured (null before a source is chosen). */
  surface: SelectedSurface['surface'] | null;
  /** The tab captured directly via tabCapture (the tab ZoomCapture was opened on), if any. */
  capturedTarget: CaptureTarget | null;
}

export const UNSUPPORTED_REASONS = {
  disabled: 'Click tracking is turned off in Settings.',
  window:
    'Clicks can’t be tracked when recording a window: Chrome extensions can only observe clicks inside a browser tab. Add zoom effects in the editor instead.',
  pickedTab:
    'Clicks are tracked only for the tab ZoomCapture was opened on. Tabs chosen in Chrome’s picker can’t be identified, so add zoom effects in the editor instead.',
  noSource: 'Choose what to record first.',
} as const;

/**
 * Whether clicks can be tracked for this capture:
 * - the tab on which the user opened ZoomCapture (the toolbar click grants `activeTab`, which lets
 *   the extension both capture that exact tab and run the click tracker in it);
 * - the entire screen, inside Chrome tabs, once the user allows access to websites (optional
 *   host permission). Clicks in other applications are not seen.
 * Everything else has a clear reason and falls back to adding zoom effects manually.
 */
export function clickTrackingSupport({ trackClicks, surface, capturedTarget }: TrackingSupportInput): TrackingSupport {
  if (!trackClicks) return { supported: false, reason: UNSUPPORTED_REASONS.disabled };
  if (surface === null) return { supported: false, reason: UNSUPPORTED_REASONS.noSource };
  if (surface === 'monitor') return { supported: true, scope: 'screen' };
  if (surface === 'window') return { supported: false, reason: UNSUPPORTED_REASONS.window };
  if (!capturedTarget) return { supported: false, reason: UNSUPPORTED_REASONS.pickedTab };
  return { supported: true, scope: 'tab' };
}

/** Websites the tracker may run on while recording the entire screen (optional host permission). */
export const SCREEN_TRACKING_ORIGINS = ['https://*/*', 'http://*/*'];
