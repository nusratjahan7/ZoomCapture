import type { CursorSample, InteractionEvent } from '@/types';
import { distance, normalizeViewportPoint, pageToFrame, type Size, type ViewportRect } from './coordinates';

/** A click as reported by the content script in the recorded tab. */
export interface TrackedClick {
  /** Epoch milliseconds (`performance.timeOrigin + event.timeStamp`), comparable across processes. */
  epochMs: number;
  clientX: number;
  clientY: number;
  button: number;
  viewport: ViewportRect;
  /** False for clicks synthesised by page scripts. */
  trusted: boolean;
}

/** Repeated presses closer than this in time and space are one interaction (e.g. a double-click). */
export const DUPLICATE_WINDOW_MS = 400;
export const DUPLICATE_DISTANCE = 0.02;

export type IgnoredReason = 'untrusted' | 'not-primary' | 'outside-content' | 'not-recording';

export type ClickResult = { event: InteractionEvent } | { ignored: IgnoredReason };

/**
 * Turns a tracked click into a timeline interaction, or explains why it is ignored.
 * `recordedTimeMs` is the click's time on the recording timeline, or null if it happened while
 * not recording (before start, while paused, after stop). `frame` is the size of the video frames
 * being recorded; positions are stored relative to the frame (see `pageToFrame`).
 */
export function toInteraction(click: TrackedClick, recordedTimeMs: number | null, id: string, frame?: Size | null): ClickResult {
  if (!click.trusted) return { ignored: 'untrusted' };
  if (click.button !== 0) return { ignored: 'not-primary' };
  if (recordedTimeMs === null) return { ignored: 'not-recording' };
  const onPage = normalizeViewportPoint({ x: click.clientX, y: click.clientY }, click.viewport);
  if (!onPage) return { ignored: 'outside-content' };
  const position = pageToFrame(onPage, click.viewport, frame);
  return {
    event: {
      id,
      type: 'click',
      timeMs: Math.round(recordedTimeMs),
      position,
      button: click.button,
      viewport: { width: Math.round(click.viewport.width), height: Math.round(click.viewport.height) },
    },
  };
}

export function isDuplicateClick(previous: InteractionEvent | undefined, next: InteractionEvent): boolean {
  return (
    previous !== undefined &&
    previous.button === next.button &&
    Math.abs(next.timeMs - previous.timeMs) < DUPLICATE_WINDOW_MS &&
    distance(previous.position, next.position) < DUPLICATE_DISTANCE
  );
}

/** Sorted by time with duplicates (double-clicks, re-delivered messages) removed. */
export function dedupeInteractions(events: InteractionEvent[]): InteractionEvent[] {
  const seen = new Set<string>();
  const result: InteractionEvent[] = [];
  for (const event of [...events].sort((a, b) => a.timeMs - b.timeMs)) {
    if (seen.has(event.id) || isDuplicateClick(result.at(-1), event)) continue;
    seen.add(event.id);
    result.push(event);
  }
  return result;
}

/** Pointer movement reported by the content script, in batches (a few per second). */
export interface TrackedPointerBatch {
  /** The captured viewport when the batch was sent. */
  viewport: ViewportRect;
  samples: Array<{ epochMs: number; clientX: number; clientY: number; hidden?: boolean }>;
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * Pointer samples on the recording timeline. Samples taken while not recording are dropped;
 * positions outside the captured content (or the pointer leaving the page) become `hidden`.
 */
export function toCursorSamples(
  batch: TrackedPointerBatch,
  recordedTimeAt: (epochMs: number) => number | null,
  frame?: Size | null,
): CursorSample[] {
  const result: CursorSample[] = [];
  for (const sample of batch.samples) {
    const time = recordedTimeAt(sample.epochMs);
    if (time === null) continue;
    const timeMs = Math.round(time);
    const onPage = sample.hidden ? null : normalizeViewportPoint({ x: sample.clientX, y: sample.clientY }, batch.viewport);
    const position = onPage && pageToFrame(onPage, batch.viewport, frame);
    result.push(position ? { timeMs, x: round4(position.x), y: round4(position.y) } : { timeMs, x: 0, y: 0, hidden: true });
  }
  return result;
}
