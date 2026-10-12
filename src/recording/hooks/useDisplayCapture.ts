import { useCallback, useEffect, useRef, useState } from 'react';
import { describeDisplayStream, requestDisplayStream } from '@/services/media/displayCapture';
import { playTabAudio, requestTargetTabStream } from '@/services/media/tabCapture';
import { stopStream } from '@/services/media/userMedia';
import type { CaptureSource, CaptureTarget, SelectedSurface, UserSettings } from '@/types';

type CaptureSettings = Pick<UserSettings, 'resolution' | 'frameRate' | 'captureSystemAudio'>;

interface Capture {
  stream: MediaStream;
  surface: SelectedSurface;
  /** Set when the tab ZoomCapture was opened on is captured directly (click tracking possible). */
  target: CaptureTarget | null;
  cleanup: () => void;
}

/**
 * Owns the shared-surface stream, from Chrome's picker (any screen, window or tab) or from direct
 * capture of the tab ZoomCapture was opened on. `onChange` fires when a surface is granted,
 * replaced, or ends (including when the user clicks Chrome's own "Stop sharing" bar).
 */
export function useDisplayCapture(onChange: (surface: SelectedSurface | null) => void) {
  const [capture, setCapture] = useState<Capture | null>(null);
  const captureRef = useRef<Capture | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const replace = useCallback((next: Capture | null) => {
    const previous = captureRef.current;
    if (previous) {
      previous.cleanup();
      stopStream(previous.stream);
    }
    captureRef.current = next;
    setCapture(next);
    if (next) {
      next.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (captureRef.current === next) replace(null);
      });
    }
    onChangeRef.current(next ? next.surface : null);
  }, []);

  /** Opens Chrome's picker. Must be called from a click handler. Rejects if dismissed. */
  const select = useCallback(
    async (source: CaptureSource, settings: CaptureSettings) => {
      const stream = await requestDisplayStream(source, settings);
      replace({ stream, surface: describeDisplayStream(stream), target: null, cleanup: () => undefined });
    },
    [replace],
  );

  /** Captures the tab ZoomCapture was opened on, keeping its audio audible for the user. */
  const selectTarget = useCallback(
    async (target: CaptureTarget, settings: CaptureSettings) => {
      const stream = await requestTargetTabStream(target, settings);
      const described = describeDisplayStream(stream);
      replace({
        stream,
        surface: { ...described, surface: 'browser', label: target.title || target.origin },
        target,
        cleanup: playTabAudio(stream),
      });
    },
    [replace],
  );

  const stop = useCallback(() => replace(null), [replace]);

  useEffect(
    () => () => {
      captureRef.current?.cleanup();
      stopStream(captureRef.current?.stream);
    },
    [],
  );

  return {
    stream: capture?.stream ?? null,
    surface: capture?.surface ?? null,
    target: capture?.target ?? null,
    select,
    selectTarget,
    stop,
  };
}
