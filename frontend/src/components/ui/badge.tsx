import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const tones = {
  neutral: 'border-line bg-wash text-fg-secondary',
  primary: 'border-primary/30 bg-primary-wash text-fg',
  success: 'border-success/30 bg-success-wash text-fg',
  warning: 'border-warning/40 bg-warning-wash text-fg',
  danger: 'border-danger/30 bg-danger-wash text-fg',
  outline: 'border-line bg-transparent text-fg-secondary',
} as const;

export type BadgeTone = keyof typeof tones;

export function Badge({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium [&_svg]:size-3',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
