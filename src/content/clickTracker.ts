/**
 * Click tracker injected (only on request, via chrome.scripting + activeTab) into the tab being
 * recorded. While recording, it reports where and when the user presses the primary mouse button
 * (to generate zoom effects) and where the pointer moves (sampled at most ~30 times a second, for
 * follow-cursor zoom and the cursor highlight). Nothing else is read: no page content, no text,
 * no keystrokes.
 *
 * Built as a standalone IIFE (vite.content.config.ts) because injected files cannot import
 * modules. While not recording, an on-page notice makes the tracking visible; it hides during
 * recording so it never appears in the video.
 */
import type { TrackedClick, TrackedPointerBatch } from '@/services/zoom/clicks';
import type { ViewportRect } from '@/services/zoom/coordinates';

interface TrackerConfig {
  sessionId: string;
  recording: boolean;
  /**
   * `tab`: this tab is the recording (positions relative to its viewport). `screen`: the entire
   * screen is recorded (positions relative to the screen this window is on).
   */
  scope?: 'tab' | 'screen';
}

interface Tracker {
  start(config: TrackerConfig): void;
  setRecording(active: boolean): void;
  stop(): void;
}

type TrackerMessage =
  | { channel: 'tracker'; type: 'ready'; sessionId: string; origin: string; title: string }
  | { channel: 'tracker'; type: 'click'; sessionId: string; click: TrackedClick }
  | { channel: 'tracker'; type: 'pointer'; sessionId: string; batch: TrackedPointerBatch }
  | { channel: 'tracker'; type: 'detached'; sessionId: string };

type ControlMessage = { channel: 'tracker-control'; sessionId: string; action: 'recording'; active: boolean } | { channel: 'tracker-control'; sessionId: string; action: 'stop' };

const GLOBAL_KEY = '__zoomCaptureTracker';
/** Minimum time between pointer samples, and how often batches are sent. */
const SAMPLE_INTERVAL_MS = 33;
const FLUSH_INTERVAL_MS = 250;
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

/**
 * The screen this window is on, in the same units as `MouseEvent.screenX/Y`. Chrome reports the
 * origin of the available area (`availLeft/availTop`), which matches the screen's origin unless
 * the taskbar is on its left or top edge.
 */
function screenRect(): ViewportRect {
  const display = screen as Screen & { availLeft?: number; availTop?: number };
  return { left: display.availLeft ?? 0, top: display.availTop ?? 0, width: display.width, height: display.height };
}

/** A pointer position in the captured area's coordinates, plus that area. */
function locate(event: PointerEvent, scope: TrackerConfig['scope']): { x: number; y: number; area: ViewportRect } {
  if (scope === 'screen') return { x: event.screenX, y: event.screenY, area: screenRect() };
  return { x: event.clientX, y: event.clientY, area: captureViewport() };
}

function createIndicator(scope: TrackerConfig['scope']): HTMLElement {
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
    <div role="status"><span class="dot"></span><span>${scope === 'screen' ? 'ZoomCapture is tracking clicks in Chrome tabs for your screen recording.' : 'ZoomCapture is tracking clicks in this tab for automatic zoom.'}
      <small>Only pointer positions and clicks are recorded, while recording. This notice is hidden while recording.</small></span></div>`;
  return host;
}

function createTracker(): Tracker {
  let config: TrackerConfig | null = null;
  let indicator: HTMLElement | null = null;
  let pending: TrackedPointerBatch['samples'] = [];
  let lastSampleAt = Number.NEGATIVE_INFINITY;
  let flushTimer = 0;

  const send = (message: TrackerMessage) => {
    try {
      void chrome.runtime.sendMessage(message).catch(() => undefined);
    } catch {
      // The extension was reloaded or removed; this script is orphaned.
      tracker.stop();
    }
  };

  const flush = () => {
    if (!config || pending.length === 0) return;
    const area = config.scope === 'screen' ? screenRect() : captureViewport();
    send({ channel: 'tracker', type: 'pointer', sessionId: config.sessionId, batch: { viewport: area, samples: pending } });
    pending = [];
  };

  const addSample = (event: PointerEvent, hidden = false, force = false) => {
    if (!config?.recording || !event.isPrimary) return;
    if (!force && event.timeStamp - lastSampleAt < SAMPLE_INTERVAL_MS) return;
    lastSampleAt = event.timeStamp;
    const point = locate(event, config.scope);
    pending.push({ epochMs: performance.timeOrigin + event.timeStamp, clientX: point.x, clientY: point.y, hidden: hidden || undefined });
  };

  const onPointerMove = (event: PointerEvent) => addSample(event);
  // `relatedTarget` is null when the pointer leaves the page entirely.
  const onPointerOut = (event: PointerEvent) => {
    if (event.relatedTarget === null) addSample(event, true, true);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!config || !event.isPrimary) return;
    addSample(event, false, true);
    const point = locate(event, config.scope);
    send({
      channel: 'tracker',
      type: 'click',
      sessionId: config.sessionId,
      click: {
        epochMs: performance.timeOrigin + event.timeStamp,
        clientX: point.x,
        clientY: point.y,
        // Touch and pen report button 0 for the primary contact as well.
        button: event.button < 0 ? 0 : event.button,
        viewport: point.area,
        trusted: event.isTrusted,
      },
    });
  };

  const onPageHide = () => {
    flush();
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
        window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
        document.addEventListener('pointerout', onPointerOut, { capture: true, passive: true });
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
        if (!flushTimer) flushTimer = window.setInterval(flush, FLUSH_INTERVAL_MS);
      } else {
        flush();
        window.clearInterval(flushTimer);
        flushTimer = 0;
      }
      if (!active && !indicator) {
        indicator = createIndicator(config?.scope);
        document.documentElement.append(indicator);
      }
    },
    stop() {
      flush();
      window.clearInterval(flushTimer);
      flushTimer = 0;
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pointermove', onPointerMove, { capture: true });
      document.removeEventListener('pointerout', onPointerOut, { capture: true });
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
