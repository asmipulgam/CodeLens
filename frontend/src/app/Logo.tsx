import { cn } from '@/lib/cn';

export function Logo({ size = 'md', withText = false }: { size?: 'md' | 'lg'; withText?: boolean }) {
  const box = size === 'lg' ? 'size-12 rounded-xl' : 'size-8 rounded-lg';
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn('grid place-items-center bg-primary text-primary-fg shadow-sm', box)} aria-hidden="true">
        <svg viewBox="0 0 32 32" className={size === 'lg' ? 'size-8' : 'size-5'}>
          <circle cx="14" cy="14" r="7" fill="none" stroke="currentColor" strokeWidth="2.75" />
          <path d="M19.5 19.5l5.5 5.5" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" />
        </svg>
      </span>
      {withText && <span className="text-base font-semibold tracking-tight">CodeLens</span>}
    </span>
  );
}
