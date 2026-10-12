import { useCallback, useEffect, useRef, useState } from 'react';
import type { TrackedClick, TrackedPointerBatch } from '@/services/zoom/clicks';
import { clickTrackingSupport } from '@/services/zoom/support';
import type { CaptureTarget, SelectedSurface } from '@/types';
import { getErrorMessage } from '@/utils/errors';

const TRACKER_FILE = 'content/click-tracker.js';

export type TrackingStatus =
  /** Not possible for this capture (screen, window, picked tab, disabled); `reason` says why. */
  | { state: 'unsupported'; reason: string }
  | { state: 'connecting' }
  | { state: 'active'; origin: string }
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

async function inject(tabId: number, sessionId: string, recording: boolean): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: [TRACKER_FILE] });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (id: string, active: boolean) =>
      (window as unknown as { __zoomCaptureTracker?: { start: (c: object) => void } }).__zoomCaptureTracker?.start({
        sessionId: id,
        recording: active,
      }),
    args: [sessionId, recording],
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

  const effective: TrackingStatus = support.supported ? status : { state: 'unsupported', reason: support.reason };
  return { status: effective, allowOnSite };
}
