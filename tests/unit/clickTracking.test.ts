import { describe, expect, it } from 'vitest';
import { RecordingClock } from '@/services/recording/RecordingClock';
import { dedupeInteractions, isDuplicateClick, toInteraction, type TrackedClick } from '@/services/zoom/clicks';
import { clickTrackingSupport, isTrackableUrl, UNSUPPORTED_REASONS } from '@/services/zoom/support';
import type { InteractionEvent } from '@/types';

const click = (overrides: Partial<TrackedClick> = {}): TrackedClick => ({
  epochMs: 1_000,
  clientX: 400,
  clientY: 300,
  button: 0,
  viewport: { left: 0, top: 0, width: 800, height: 600 },
  trusted: true,
  ...overrides,
});

const event = (id: string, timeMs: number, x = 0.5, y = 0.5): InteractionEvent => ({
  id,
  type: 'click',
  timeMs,
  position: { x, y },
  button: 0,
  viewport: { width: 800, height: 600 },
});

describe('turning tracked clicks into timeline events', () => {
  it('accepts a trusted primary click inside the content', () => {
    const result = toInteraction(click(), 1234.6, 'ev_1');
    expect(result).toEqual({
      event: { id: 'ev_1', type: 'click', timeMs: 1235, position: { x: 0.5, y: 0.5 }, button: 0, viewport: { width: 800, height: 600 } },
    });
  });

  it('ignores clicks that should not create zoom effects', () => {
    expect(toInteraction(click({ trusted: false }), 10, 'a')).toEqual({ ignored: 'untrusted' });
    expect(toInteraction(click({ button: 2 }), 10, 'a')).toEqual({ ignored: 'not-primary' });
    expect(toInteraction(click(), null, 'a')).toEqual({ ignored: 'not-recording' });
    expect(toInteraction(click({ clientX: 900 }), 10, 'a')).toEqual({ ignored: 'outside-content' });
    expect(toInteraction(click({ clientY: -5 }), 10, 'a')).toEqual({ ignored: 'outside-content' });
  });
});

describe('duplicate events', () => {
  it('treats a double-click (same place, within 400 ms) as one interaction', () => {
    expect(isDuplicateClick(event('a', 1000), event('b', 1250))).toBe(true);
    expect(isDuplicateClick(event('a', 1000, 0.5, 0.5), event('b', 1100, 0.51, 0.505))).toBe(true);
  });

  it('keeps quick clicks in different places and slow repeated clicks in the same place', () => {
    expect(isDuplicateClick(event('a', 1000, 0.2, 0.2), event('b', 1100, 0.8, 0.8))).toBe(false);
    expect(isDuplicateClick(event('a', 1000), event('b', 1500))).toBe(false);
    expect(isDuplicateClick(undefined, event('b', 1500))).toBe(false);
  });

  it('removes re-delivered and double-click duplicates and sorts by time', () => {
    const deduped = dedupeInteractions([event('c', 5000), event('a', 1000), event('a', 1000), event('b', 1200), event('d', 9000, 0.1, 0.1)]);
    expect(deduped.map((e) => e.id)).toEqual(['a', 'c', 'd']);
  });
});

describe('timestamp synchronization', () => {
  it('places events on the recorded timeline by when they happened, excluding pauses', () => {
    const clock = new RecordingClock();
    clock.start(1000);
    clock.pause(4000); // recorded 0–3000 ms
    clock.resume(10_000); // 6 s pause
    clock.pause(12_000); // recorded 3000–5000 ms

    expect(clock.recordedTimeAt(1000)).toBe(0);
    expect(clock.recordedTimeAt(2500)).toBe(1500);
    expect(clock.recordedTimeAt(7000)).toBeNull(); // during the pause
    expect(clock.recordedTimeAt(11_000)).toBe(4000);
    expect(clock.recordedTimeAt(500)).toBeNull(); // before recording
    expect(clock.recordedTimeAt(13_000)).toBeNull(); // after stopping
    expect(clock.elapsed(99_999)).toBe(5000);
  });

  it('maps epoch timestamps from another tab via performance.timeOrigin', () => {
    const clock = new RecordingClock();
    const now = performance.now();
    clock.start(now);
    const epoch = performance.timeOrigin + now + 750;
    expect(clock.recordedTimeAtEpoch(epoch)).toBeCloseTo(750, 2);
  });

  it('still places a click correctly when its message arrives after a pause began', () => {
    const clock = new RecordingClock();
    clock.start(0);
    clock.pause(5000);
    // The click happened at 4900 ms but its message is processed now, during the pause.
    expect(clock.recordedTimeAt(4900)).toBe(4900);
  });
});

describe('unsupported capture sources', () => {
  const target = { tabId: 7, title: 'Docs', origin: 'https://docs.example' };

  it('supports only the tab ZoomCapture was opened on, captured directly', () => {
    expect(clickTrackingSupport({ trackClicks: true, surface: 'browser', capturedTarget: target })).toEqual({ supported: true });
  });

  it('explains why other sources are not tracked', () => {
    expect(clickTrackingSupport({ trackClicks: true, surface: 'monitor', capturedTarget: null })).toEqual({
      supported: false,
      reason: UNSUPPORTED_REASONS.screen,
    });
    expect(clickTrackingSupport({ trackClicks: true, surface: 'window', capturedTarget: null })).toEqual({
      supported: false,
      reason: UNSUPPORTED_REASONS.window,
    });
    // A tab chosen in Chrome's picker cannot be identified, so it is not tracked either.
    expect(clickTrackingSupport({ trackClicks: true, surface: 'browser', capturedTarget: null })).toEqual({
      supported: false,
      reason: UNSUPPORTED_REASONS.pickedTab,
    });
    expect(clickTrackingSupport({ trackClicks: false, surface: 'browser', capturedTarget: target })).toEqual({
      supported: false,
      reason: UNSUPPORTED_REASONS.disabled,
    });
    expect(clickTrackingSupport({ trackClicks: true, surface: null, capturedTarget: target }).supported).toBe(false);
  });

  it('never claims desktop-wide tracking', () => {
    for (const reason of [UNSUPPORTED_REASONS.screen, UNSUPPORTED_REASONS.window]) {
      expect(reason).toMatch(/can only observe clicks inside a browser tab/);
    }
  });

  it('recognises pages where Chrome forbids extension scripts', () => {
    expect(isTrackableUrl('https://example.com/app')).toBe(true);
    expect(isTrackableUrl('http://localhost:3000')).toBe(true);
    expect(isTrackableUrl('chrome://settings')).toBe(false);
    expect(isTrackableUrl('chrome-extension://abc/page.html')).toBe(false);
    expect(isTrackableUrl('https://chromewebstore.google.com/detail/x')).toBe(false);
    expect(isTrackableUrl('https://chrome.google.com/webstore/detail/x')).toBe(false);
    expect(isTrackableUrl('file:///C:/page.html')).toBe(false);
    expect(isTrackableUrl(undefined)).toBe(false);
    expect(isTrackableUrl('not a url')).toBe(false);
  });
});
