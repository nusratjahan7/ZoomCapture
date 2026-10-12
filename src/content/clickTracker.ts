/**
 * Click tracker injected (only on request, via chrome.scripting + activeTab) into the tab being
 * recorded. It reports where and when the user presses the primary mouse button, so zoom
 * effects can be generated. Nothing else is read: no page content, no text, no keystrokes.
 *
 * Built as a standalone IIFE (vite.content.config.ts) because injected files cannot import
 * modules. While not recording, an on-page notice makes the tracking visible; it hides during
 * recording so it never appears in the video.
 */
import type { TrackedClick } from '@/services/zoom/clicks';
import type { ViewportRect } from '@/services/zoom/coordinates';

interface TrackerConfig {
  sessionId: string;
  recording: boolean;
}

interface Tracker {
  start(config: TrackerConfig): void;
  setRecording(active: boolean): void;
  stop(): void;
}

type TrackerMessage =
  | { channel: 'tracker'; type: 'ready'; sessionId: string; origin: string; title: string }
  | { channel: 'tracker'; type: 'click'; sessionId: string; click: TrackedClick }
  | { channel: 'tracker'; type: 'detached'; sessionId: string };

type ControlMessage = { channel: 'tracker-control'; sessionId: string; action: 'recording'; active: boolean } | { channel: 'tracker-control'; sessionId: string; action: 'stop' };

const GLOBAL_KEY = '__zoomCaptureTracker';
const scope = window as unknown as Record<string, Tracker | undefined>;

function captureViewport(): ViewportRect {
  const visual = window.visualViewport;
  // Tab capture records the visible viewport. With pinch-zoom only the visual viewport is visible;
  // otherwise the full window (scrollbars included) is.
  if (visual && Math.abs(visual.scale - 1) > 0.01) {
    return { left: visual.offsetLeft, top: visual.offsetTop, width: visual.width, height: visual.height };
  }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

function createIndicator(): HTMLElement {
  const host = document.createElement('zoomcapture-indicator');
  host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      div { font: 500 12px/1.4 system-ui, sans-serif; color: #eceef4; background: rgba(15,17,24,.92);
            border: 1px solid #363c50; border-radius: 12px; padding: 10px 12px; max-width: 280px;
            box-shadow: 0 12px 40px -12px rgba(0,0,0,.65); display: flex; gap: 8px; }
      span.dot { width: 8px; height: 8px; border-radius: 50%; background: #22d3ee; margin-top: 4px; flex: none; }
      small { display: block; color: #a3a9bb; margin-top: 2px; }
    </style>
    <div role="status"><span class="dot"></span><span>ZoomCapture is tracking clicks in this tab for automatic zoom.
      <small>Only click positions and times are recorded. This notice is hidden while recording.</small></span></div>`;
  return host;
}

function createTracker(): Tracker {
  let config: TrackerConfig | null = null;
  let indicator: HTMLElement | null = null;

  const send = (message: TrackerMessage) => {
    try {
      void chrome.runtime.sendMessage(message).catch(() => undefined);
    } catch {
      // The extension was reloaded or removed; this script is orphaned.
      tracker.stop();
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!config || !event.isPrimary) return;
    send({
      channel: 'tracker',
      type: 'click',
      sessionId: config.sessionId,
      click: {
        epochMs: performance.timeOrigin + event.timeStamp,
        clientX: event.clientX,
        clientY: event.clientY,
        // Touch and pen report button 0 for the primary contact as well.
        button: event.button < 0 ? 0 : event.button,
        viewport: captureViewport(),
        trusted: event.isTrusted,
      },
    });
  };

  const onPageHide = () => {
    if (config) send({ channel: 'tracker', type: 'detached', sessionId: config.sessionId });
  };

  const onControl = (message: ControlMessage) => {
    if (message?.channel !== 'tracker-control' || message.sessionId !== config?.sessionId) return;
    if (message.action === 'recording') tracker.setRecording(message.active);
    else tracker.stop();
  };

  const tracker: Tracker = {
    start(next) {
      const firstStart = config === null;
      config = next;
      if (firstStart) {
        window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
        window.addEventListener('pagehide', onPageHide);
        chrome.runtime.onMessage.addListener(onControl);
      }
      tracker.setRecording(next.recording);
      send({ channel: 'tracker', type: 'ready', sessionId: next.sessionId, origin: location.origin, title: document.title });
    },
    setRecording(active) {
      if (config) config.recording = active;
      if (active) {
        indicator?.remove();
        indicator = null;
      } else if (!indicator) {
        indicator = createIndicator();
        document.documentElement.append(indicator);
      }
    },
    stop() {
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pagehide', onPageHide);
      try {
        chrome.runtime.onMessage.removeListener(onControl);
      } catch {
        // Extension context already gone.
      }
      indicator?.remove();
      indicator = null;
      config = null;
      delete scope[GLOBAL_KEY];
    },
  };
  return tracker;
}

scope[GLOBAL_KEY] ??= createTracker();
