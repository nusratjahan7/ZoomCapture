/**
 * Monotonic clock that measures recorded time, excluding pauses.
 *
 * It keeps the history of recording segments, so an event that arrives late (e.g. a click
 * message from another tab) can still be placed on the timeline by the moment it happened, and
 * events that happened while paused are recognised as such.
 */
export class RecordingClock {
  /** Each segment: performance.now() range and the recorded time at its start. */
  private segments: Array<{ start: number; end: number | null; offset: number }> = [];

  start(now = performance.now()): void {
    this.segments = [{ start: now, end: null, offset: 0 }];
  }

  pause(now = performance.now()): void {
    const current = this.segments.at(-1);
    if (current && current.end === null) current.end = now;
  }

  resume(now = performance.now()): void {
    const last = this.segments.at(-1);
    if (!last || last.end === null) return;
    this.segments.push({ start: now, end: null, offset: last.offset + (last.end - last.start) });
  }

  /** Recorded milliseconds so far. */
  elapsed(now = performance.now()): number {
    const last = this.segments.at(-1);
    if (!last) return 0;
    return last.offset + ((last.end ?? now) - last.start);
  }

  /**
   * Recorded time at which something happened at `performanceTime` (same time base as
   * `performance.now()` in this page), or null if the recorder was not running then.
   */
  recordedTimeAt(performanceTime: number): number | null {
    for (const segment of this.segments) {
      const end = segment.end ?? Number.POSITIVE_INFINITY;
      if (performanceTime >= segment.start && performanceTime <= end) return segment.offset + (performanceTime - segment.start);
    }
    return null;
  }

  /** Same as `recordedTimeAt`, for an epoch timestamp (e.g. `performance.timeOrigin + event.timeStamp` in another tab). */
  recordedTimeAtEpoch(epochMs: number): number | null {
    return this.recordedTimeAt(epochMs - performance.timeOrigin);
  }
}
