/** Monotonic clock that measures recorded time, excluding pauses. */
export class RecordingClock {
  private startedAt: number | null = null;
  private pausedAt: number | null = null;
  private pausedTotal = 0;

  start(now = performance.now()): void {
    this.startedAt = now;
    this.pausedAt = null;
    this.pausedTotal = 0;
  }

  pause(now = performance.now()): void {
    if (this.startedAt !== null && this.pausedAt === null) this.pausedAt = now;
  }

  resume(now = performance.now()): void {
    if (this.pausedAt === null) return;
    this.pausedTotal += now - this.pausedAt;
    this.pausedAt = null;
  }

  /** Recorded milliseconds so far. */
  elapsed(now = performance.now()): number {
    if (this.startedAt === null) return 0;
    return (this.pausedAt ?? now) - this.startedAt - this.pausedTotal;
  }
}
