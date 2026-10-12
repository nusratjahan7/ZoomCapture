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

export type TrackingSupport = { supported: true } | { supported: false; reason: string };

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
  screen:
    'Clicks can’t be tracked when recording the entire screen: Chrome extensions can only observe clicks inside a browser tab. Add zoom effects in the editor instead.',
  window:
    'Clicks can’t be tracked when recording a window: Chrome extensions can only observe clicks inside a browser tab. Add zoom effects in the editor instead.',
  pickedTab:
    'Clicks are tracked only for the tab ZoomCapture was opened on. Tabs chosen in Chrome’s picker can’t be identified, so add zoom effects in the editor instead.',
  noSource: 'Choose what to record first.',
} as const;

/**
 * Whether clicks can be tracked for this capture. Only one case is supported: recording the tab
 * on which the user opened ZoomCapture (the toolbar click grants `activeTab`, which lets the
 * extension both capture that exact tab and run the click tracker in it). Everything else has a
 * clear reason and falls back to adding zoom effects manually.
 */
export function clickTrackingSupport({ trackClicks, surface, capturedTarget }: TrackingSupportInput): TrackingSupport {
  if (!trackClicks) return { supported: false, reason: UNSUPPORTED_REASONS.disabled };
  if (surface === null) return { supported: false, reason: UNSUPPORTED_REASONS.noSource };
  if (surface === 'monitor') return { supported: false, reason: UNSUPPORTED_REASONS.screen };
  if (surface === 'window') return { supported: false, reason: UNSUPPORTED_REASONS.window };
  if (!capturedTarget) return { supported: false, reason: UNSUPPORTED_REASONS.pickedTab };
  return { supported: true };
}
