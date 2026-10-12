import { useCallback, useEffect, useRef, useState } from 'react';
import { describeDisplayStream, requestDisplayStream } from '@/services/media/displayCapture';
import { stopStream } from '@/services/media/userMedia';
import type { CaptureSource, SelectedSurface, UserSettings } from '@/types';

type CaptureSettings = Pick<UserSettings, 'resolution' | 'frameRate' | 'captureSystemAudio'>;

/**
 * Owns the shared-surface stream. `onChange` fires when a surface is granted, replaced, or
 * ends (including when the user clicks Chrome's own "Stop sharing" bar).
 */
export function useDisplayCapture(onChange: (surface: SelectedSurface | null) => void) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const replace = useCallback((next: MediaStream | null) => {
    stopStream(streamRef.current);
    streamRef.current = next;
    setStream(next);
    onChangeRef.current(next ? describeDisplayStream(next) : null);
  }, []);

  /** Opens Chrome's picker. Must be called from a click handler. Rejects if dismissed. */
  const select = useCallback(
    async (source: CaptureSource, settings: CaptureSettings) => {
      const next = await requestDisplayStream(source, settings);
      next.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (streamRef.current === next) replace(null);
      });
      replace(next);
    },
    [replace],
  );

  const stop = useCallback(() => replace(null), [replace]);

  useEffect(() => () => stopStream(streamRef.current), []);

  return { stream, surface: stream ? describeDisplayStream(stream) : null, select, stop };
}
