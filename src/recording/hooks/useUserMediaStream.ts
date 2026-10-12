import { useEffect, useState } from 'react';
import { stopStream } from '@/services/media/userMedia';
import { describeMediaError } from '@/utils/errors';

function isMissingDevice(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError');
}

/**
 * Acquires a camera/microphone stream while `enabled` is true and releases it when disabled,
 * when the device changes, or on unmount. `retry()` re-requests after a failure.
 *
 * If the chosen device is unavailable it falls back to the system default (`usingFallback`).
 * If the device disappears while in use, the stream is dropped and `error` explains why.
 */
export function useUserMediaStream(
  enabled: boolean,
  deviceId: string,
  request: (deviceId: string) => Promise<MediaStream>,
  deviceName: string,
) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [usingFallback, setUsingFallback] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setError(null);
      setUsingFallback(false);
      return;
    }
    let cancelled = false;
    let acquired: MediaStream | null = null;
    const onEnded = () => {
      if (cancelled) return;
      setStream(null);
      setError(`The ${deviceName} was disconnected or stopped by the system.`);
    };

    const acquire = async () => {
      setPending(true);
      try {
        let value: MediaStream;
        let fallback = false;
        try {
          value = await request(deviceId);
        } catch (err) {
          if (!deviceId || !isMissingDevice(err)) throw err;
          value = await request('');
          fallback = true;
        }
        if (cancelled) return stopStream(value);
        acquired = value;
        value.getTracks().forEach((track) => track.addEventListener('ended', onEnded));
        setStream(value);
        setUsingFallback(fallback);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(describeMediaError(err, deviceName));
      } finally {
        if (!cancelled) setPending(false);
      }
    };
    void acquire();

    return () => {
      cancelled = true;
      acquired?.getTracks().forEach((track) => track.removeEventListener('ended', onEnded));
      stopStream(acquired);
      setStream(null);
    };
  }, [enabled, deviceId, request, deviceName, attempt]);

  return { stream, error, pending, usingFallback, retry: () => setAttempt((n) => n + 1) };
}
