import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const variants = {
  primary: 'bg-primary text-primary-fg hover:bg-primary/90',
  secondary: 'border border-line bg-wash text-fg hover:bg-wash/70',
  outline: 'border border-line bg-surface text-fg hover:bg-wash',
  ghost: 'text-fg hover:bg-wash',
  danger: 'bg-danger text-danger-fg hover:bg-danger/90',
  link: 'h-auto px-0 text-primary underline-offset-4 hover:underline',
} as const;

const sizes = {
  sm: 'h-8 gap-1.5 px-3 text-sm',
  md: 'h-9 gap-2 px-4 text-sm',
  lg: 'h-11 gap-2 px-6 text-base',
  icon: 'h-9 w-9',
  'icon-sm': 'h-8 w-8',
} as const;

export type ButtonVariant = keyof typeof variants;
export type ButtonSize = keyof typeof sizes;

export function buttonClass(options: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  const { variant = 'primary', size = 'md', className } = options;
  return cn(
    'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-page',
    'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
    variants[variant],
    sizes[size],
    className,
  );
}

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant, size, className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={buttonClass({ variant, size, className })} {...props} />;
}
