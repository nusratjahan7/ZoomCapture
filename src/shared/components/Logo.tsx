import { useId } from 'react';
import { cn } from '@/utils/cn';

/** ZoomCapture mark: a zoom lens framing a record dot. Mirrors the extension icon. */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  const gradientId = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={className}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7c5cff" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${gradientId})`} />
      <circle cx="14" cy="14" r="6.9" fill="none" stroke="#fff" strokeWidth="3.4" />
      <circle cx="14" cy="14" r="3.2" fill="#ff4d5e" />
      <path d="M19.6 19.6 24.8 24.8" stroke="#fff" strokeWidth="3.8" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ size = 28, className, subtitle }: { size?: number; className?: string; subtitle?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <LogoMark size={size} />
      <div className="leading-none">
        <span className="block text-[15px] font-semibold tracking-tight text-fg">
          Zoom<span className="bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-transparent">Capture</span>
        </span>
        {subtitle && <span className="mt-1 block text-[11px] font-medium text-fg-subtle">{subtitle}</span>}
      </div>
    </div>
  );
}
