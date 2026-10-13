import { useEffect, useRef, useState } from 'react';
import { NativeControls, type NativeCommand, type NativeControlsState } from '@/services/nativeControls';

export type NativeControlsStatus =
  | { state: 'off' }
  | { state: 'connecting' }
  /** On screen; `excluded`: Windows leaves it out of screen captures. */
  | { state: 'shown'; excluded: boolean }
  | { state: 'failed'; reason: string };

/**
 * Shows the Windows controls helper while `active` (an entire-screen recording with the setting on)
 * and keeps it in sync: timer, paused state and microphone. Its buttons call `onCommand`. The
 * helper quits when this stops being active or the studio closes.
 */
export function useNativeControls(input: { active: boolean; state: NativeControlsState; onCommand: (command: NativeCommand) => void }): NativeControlsStatus {
  const { active, state } = input;
  const [status, setStatus] = useState<NativeControlsStatus>({ state: 'off' });
  const controls = useRef<NativeControls | null>(null);
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    if (!active) {
      setStatus({ state: 'off' });
      return;
    }
    let cancelled = false;
    setStatus({ state: 'connecting' });
    NativeControls.connect({
      onCommand: (command) => latest.current.onCommand(command),
      onDisconnect: (reason) => {
        controls.current = null;
        if (!cancelled) setStatus({ state: 'failed', reason });
      },
    }).then(
      (connected) => {
        if (cancelled) return connected.close();
        controls.current = connected;
        connected.show(latest.current.state);
        setStatus({ state: 'shown', excluded: connected.excluded });
      },
      (error: unknown) => {
        if (!cancelled) setStatus({ state: 'failed', reason: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
      controls.current?.hide();
      controls.current?.close();
      controls.current = null;
    };
  }, [active]);

  // The helper keeps its own clock between updates; it is resynced every second and on changes.
  const second = Math.floor(state.elapsedMs / 1000);
  useEffect(() => {
    controls.current?.update(latest.current.state);
  }, [state.phase, state.micAvailable, state.micMuted, second, status.state]);

  return status;
}
