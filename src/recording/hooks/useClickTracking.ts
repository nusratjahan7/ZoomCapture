import { useCallback, useEffect, useRef, useState } from 'react';
import type { TrackedClick, TrackedPointerBatch } from '@/services/zoom/clicks';
import { clickTrackingSupport, isTrackableUrl, SCREEN_TRACKING_ORIGINS, type TrackingScope } from '@/services/zoom/support';
import type { CaptureTarget, SelectedSurface } from '@/types';
import { getErrorMessage } from '@/utils/errors';

const TRACKER_FILE = 'content/click-tracker.js';

export type TrackingStatus =
  /** Not possible for this capture (screen, window, picked tab, disabled); `reason` says why. */
  | { state: 'unsupported'; reason: string }
  | { state: 'connecting' }
  /** Entire screen: Chrome must first allow ZoomCapture to observe clicks on websites. */
  | { state: 'needs-permission' }
  | { state: 'active'; origin: string; scope?: TrackingScope }
  /** The page navigated and ZoomCapture's temporary access ended; can be resumed per site. */
  | { state: 'paused'; reason: string; origin: string }
  | { state: 'error'; reason: string };

type TrackerMessage =
  | { channel: 'tracker'; type: 'ready'; sessionId: string; origin: string }
  | { channel: 'tracker'; type: 'click'; sessionId: string; click: TrackedClick }
  | { channel: 'tracker'; type: 'pointer'; sessionId: string; batch: TrackedPointerBatch }
  | { channel: 'tracker'; type: 'detached'; sessionId: string };

function isTrackerMessage(message: unknown): message is TrackerMessage {
  return typeof message === 'object' && message !== null && (message as TrackerMessage).channel === 'tracker';
}

async function inject(tabId: number, sessionId: string, recording: boolean, scope: TrackingScope = 'tab'): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: [TRACKER_FILE] });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (id: string, active: boolean, area: string) =>
      (window as unknown as { __zoomCaptureTracker?: { start: (c: object) => void } }).__zoomCaptureTracker?.start({
        sessionId: id,
        recording: active,
        scope: area,
      }),
    args: [sessionId, recording, scope],
  });
}

function sendControl(tabId: number, message: object) {
  void chrome.tabs.sendMessage(tabId, { channel: 'tracker-control', ...message }).catch(() => undefined);
}

/**
 * Runs the click tracker in the captured tab while the source supports it, and delivers verified
 * clicks to `onClick`. Tracking is transparent: the page shows a notice while not recording, and
 * the studio shows the status and the reason when tracking is unavailable.
 */
export function useClickTracking(input: {
  sessionId: string | null;
  enabled: boolean;
  surface: SelectedSurface | null;
  target: CaptureTarget | null;
  recording: boolean;
  onClick: (click: TrackedClick) => void;
  /** Pointer movement while recording (follow-cursor zoom, cursor highlight). */
  onPointer: (batch: TrackedPointerBatch) => void;
}) {
  const { sessionId, enabled, surface, target, recording } = input;
  const support = clickTrackingSupport({ trackClicks: enabled, surface: surface?.surface ?? null, capturedTarget: target });
  const [status, setStatus] = useState<TrackingStatus>({ state: 'connecting' });
  const onClickRef = useRef(input.onClick);
  onClickRef.current = input.onClick;
  const onPointerRef = useRef(input.onPointer);
  onPointerRef.current = input.onPointer;
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const tabId = support.supported ? target?.tabId : undefined;

  const attach = useCallback(async () => {
    if (tabId === undefined || !sessionId || !target) return;
    setStatus({ state: 'connecting' });
    try {
      await inject(tabId, sessionId, recordingRef.current);
    } catch (error) {
      const message = getErrorMessage(error);
      setStatus(
        /Cannot access|permission|must request/i.test(message)
          ? {
              state: 'paused',
              origin: target.origin,
              reason:
                'The tab moved to another site, which ends ZoomCapture’s access to it. To resume, click the ZoomCapture icon in the toolbar while on that tab.',
            }
          : { state: 'error', reason: `Click tracking could not start: ${message}` },
      );
    }
  }, [tabId, sessionId, target]);

  // Inject when a supported source is captured; remove the tracker when it no longer is.
  useEffect(() => {
    if (tabId === undefined || !sessionId) return;
    void attach();
    return () => sendControl(tabId, { sessionId, action: 'stop' });
  }, [tabId, sessionId, attach]);

  // Opening the popup on the recorded tab grants access again (activeTab): re-attach then.
  useEffect(() => {
    if (tabId === undefined || !sessionId) return;
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      const request = message as { channel?: string; sessionId?: string; tabId?: number };
      if (sender.id !== chrome.runtime.id || request?.channel !== 'tracking-reattach') return false;
      if (request.sessionId === sessionId && request.tabId === tabId) void attach();
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [tabId, sessionId, attach]);

  // Messages from the tracker: accepted only from the captured tab and this session.
  useEffect(() => {
    if (tabId === undefined || !sessionId) return;
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (!isTrackerMessage(message) || sender.tab?.id !== tabId || message.sessionId !== sessionId) return false;
      if (message.type === 'ready') setStatus({ state: 'active', origin: message.origin });
      else if (message.type === 'detached') setStatus({ state: 'connecting' });
      else if (message.type === 'pointer') onPointerRef.current(message.batch);
      else onClickRef.current(message.click);
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [tabId, sessionId]);

  // After a navigation, try to resume (works within the same page, or with site access granted).
  useEffect(() => {
    if (tabId === undefined) return;
    const onUpdated = (updatedTabId: number, change: { status?: string }) => {
      if (updatedTabId === tabId && change.status === 'complete') void attach();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => chrome.tabs.onUpdated.removeListener(onUpdated);
  }, [tabId, attach]);

  // The on-page notice hides while recording so it never appears in the video.
  useEffect(() => {
    if (tabId !== undefined && sessionId) sendControl(tabId, { sessionId, action: 'recording', active: recording });
  }, [tabId, sessionId, recording]);

  /**
   * Asks for permission to keep tracking on this site after navigations (optional host
   * permission for one origin only). Must be called from a click.
   */
  const allowOnSite = useCallback(async () => {
    if (status.state !== 'paused') return false;
    const granted = await chrome.permissions.request({ origins: [`${status.origin}/*`] });
    if (granted) await attach();
    return granted;
  }, [status, attach]);

  const screen = useScreenTracking({
    sessionId,
    active: support.supported && support.scope === 'screen',
    recording,
    recordingRef,
    onClick: (click) => onClickRef.current(click),
    onPointer: (batch) => onPointerRef.current(batch),
  });

  const effective: TrackingStatus = !support.supported
    ? { state: 'unsupported', reason: support.reason }
    : support.scope === 'screen'
      ? screen.status
      : status;
  return { status: effective, allowOnSite, allowScreen: screen.allow, scope: support.supported ? support.scope : null };
}

const SCREEN_LABEL = 'Chrome tabs on this screen';

/**
 * Entire-screen recording: runs the tracker in every website tab (once the user allows access to
 * websites), including tabs opened or reloaded while recording. Positions are reported relative to
 * the screen, so they line up with the recorded picture. Clicks outside Chrome are not seen.
 */
function useScreenTracking(input: {
  sessionId: string | null;
  active: boolean;
  recording: boolean;
  recordingRef: { current: boolean };
  onClick: (click: TrackedClick) => void;
  onPointer: (batch: TrackedPointerBatch) => void;
}) {
  const { sessionId, active, recording, recordingRef } = input;
  const [granted, setGranted] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const injected = useRef(new Set<number>());
  const handlers = useRef(input);
  handlers.current = input;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void chrome.permissions
      .contains({ origins: SCREEN_TRACKING_ORIGINS })
      .then((has) => !cancelled && setGranted(has))
      .catch(() => !cancelled && setGranted(false));
    return () => {
      cancelled = true;
    };
  }, [active]);

  const running = active && granted === true && sessionId !== null;

  useEffect(() => {
    if (!running || !sessionId) return;
    const tabs = injected.current;
    const attach = async (tab: chrome.tabs.Tab) => {
      if (tab.id === undefined || !isTrackableUrl(tab.url) || tab.discarded) return;
      try {
        await inject(tab.id, sessionId, recordingRef.current, 'screen');
        tabs.add(tab.id);
      } catch {
        // A tab that can't be scripted (e.g. still loading, or an error page) is skipped.
      }
    };
    void chrome.tabs
      .query({})
      .then((all) => Promise.all(all.map(attach)))
      .catch((reason: unknown) => setError(`Click tracking could not start: ${getErrorMessage(reason)}`));
    const onUpdated = (_id: number, change: { status?: string }, tab: chrome.tabs.Tab) => {
      if (change.status === 'complete') void attach(tab);
    };
    const onRemoved = (tabId: number) => tabs.delete(tabId);
    const onMessage = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (!isTrackerMessage(message) || sender.tab?.id === undefined || message.sessionId !== sessionId) return false;
      if (message.type === 'pointer') handlers.current.onPointer(message.batch);
      else if (message.type === 'click') handlers.current.onClick(message.click);
      return false;
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.runtime.onMessage.removeListener(onMessage);
      for (const tabId of tabs) sendControl(tabId, { sessionId, action: 'stop' });
      tabs.clear();
    };
  }, [running, sessionId, recordingRef]);

  // The on-page notices hide while recording so they never appear in the video.
  useEffect(() => {
    if (!running || !sessionId) return;
    for (const tabId of injected.current) sendControl(tabId, { sessionId, action: 'recording', active: recording });
  }, [running, sessionId, recording]);

  /** Asks Chrome for access to websites (optional host permission). Must be called from a click. */
  const allow = useCallback(async () => {
    const ok = await chrome.permissions.request({ origins: SCREEN_TRACKING_ORIGINS }).catch(() => false);
    setGranted(ok);
    return ok;
  }, []);

  const status: TrackingStatus =
    error !== null
      ? { state: 'error', reason: error }
      : granted === null
        ? { state: 'connecting' }
        : granted
          ? { state: 'active', origin: SCREEN_LABEL, scope: 'screen' }
          : { state: 'needs-permission' };
  return { status, allow };
}
