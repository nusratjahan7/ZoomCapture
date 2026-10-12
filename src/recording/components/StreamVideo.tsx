import { useEffect, useRef } from 'react';
import { cn } from '@/utils/cn';

/** Muted live preview of a MediaStream. */
export function StreamVideo({
  stream,
  label,
  mirrored,
  className,
}: {
  stream: MediaStream;
  label: string;
  mirrored?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  return (
    <video
      ref={ref}
      aria-label={label}
      autoPlay
      muted
      playsInline
      className={cn('h-full w-full bg-black object-contain', mirrored && '-scale-x-100', className)}
    />
  );
}
