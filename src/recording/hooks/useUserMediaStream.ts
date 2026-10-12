import { useEffect, useState } from 'react';
import { stopStream } from '@/services/media/userMedia';
import { describeMediaError } from '@/utils/errors';

/**
 * Acquires a camera/microphone stream while `enabled` is true and releases it when disabled,
 * when the device changes, or on unmount. `retry()` re-requests after a failure.
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
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setError(null);
      return;
    }
    let cancelled = false;
    let acquired: MediaStream | null = null;
    setPending(true);
    request(deviceId).then(
      (value) => {
        if (cancelled) return stopStream(value);
        acquired = value;
        setStream(value);
        setError(null);
        setPending(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(describeMediaError(err, deviceName));
        setPending(false);
      },
    );
    return () => {
      cancelled = true;
      stopStream(acquired);
      setStream(null);
    };
  }, [enabled, deviceId, request, deviceName, attempt]);

  return { stream, error, pending, retry: () => setAttempt((n) => n + 1) };
}
