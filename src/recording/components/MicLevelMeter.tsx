import { useEffect, useRef } from 'react';
import { startAudioLevelMeter } from '@/services/media/audioLevel';

const SEGMENTS = 24;

/**
 * Live input level. Updates the DOM directly from the animation-frame callback instead of
 * React state to avoid re-rendering 60 times a second.
 */
export function MicLevelMeter({ stream }: { stream: MediaStream }) {
  const barsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return startAudioLevelMeter(stream, (level) => {
      const active = Math.round(level * SEGMENTS);
      barsRef.current?.childNodes.forEach((node, index) => {
        (node as HTMLElement).dataset.on = String(index < active);
      });
    });
  }, [stream]);

  return (
    <div>
      <div ref={barsRef} aria-hidden className="flex h-6 items-end gap-[3px]">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span
            key={i}
            data-on="false"
            className="h-full flex-1 rounded-[2px] bg-surface-3 transition-colors duration-75 data-[on=true]:bg-success data-[on=true]:nth-[n+17]:bg-warning data-[on=true]:nth-[n+22]:bg-rec"
          />
        ))}
      </div>
      <p className="mt-2 text-xs text-fg-subtle">Speak to test your microphone level.</p>
    </div>
  );
}
