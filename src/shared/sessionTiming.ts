import { useEffect, useState } from 'react';
import type { SessionTiming } from '@/types';

export function sessionElapsedMs(timing: SessionTiming | undefined, now = Date.now()): number {
  if (!timing) return 0;
  return Math.max(0, (timing.pausedAt ?? now) - timing.startedAt - timing.pausedMs);
}

/** Elapsed recorded time of a session, re-rendering every 250 ms while it is running. */
export function useSessionElapsed(timing: SessionTiming | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const running = timing !== undefined && timing.pausedAt === undefined;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [running]);
  return sessionElapsedMs(timing, now);
}
