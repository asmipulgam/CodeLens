import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

const fieldBase =
  'w-full rounded-md border border-line bg-raised px-3 text-sm text-fg placeholder:text-fg-muted ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-page ' +
  'disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(fieldBase, 'h-9', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldBase, 'min-h-20 py-2 leading-relaxed', className)} {...props} />;
}

export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <select className={cn(fieldBase, 'h-9 cursor-pointer pr-8', className)} {...props}>
      {children}
    </select>
  );
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium text-fg', className)} {...props} />;
}

export function FieldHint({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-xs text-fg-secondary', className)} {...props} />;
}

export function FieldError({ className, children, ...props }: ComponentProps<'p'>) {
  if (!children) return null;
  return (
    <p role="alert" className={cn('text-xs font-medium text-danger', className)} {...props}>
      {children}
    </p>
  );
}

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/** Label + control + hint/error, wired together for screen readers. */
export function Field({ id, label, hint, error, required, className, children }: FieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>
        {label}
        {required && (
          <span className="ml-0.5 text-danger" aria-hidden="true">
            *
          </span>
        )}
      </Label>
      {children}
      {hint && !error && <FieldHint id={`${id}-hint`}>{hint}</FieldHint>}
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}
