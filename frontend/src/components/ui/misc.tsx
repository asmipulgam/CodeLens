import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" className="inline-flex items-center">
      <Loader2 className={cn('size-4 animate-spin text-fg-secondary', className)} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-md bg-wash', className)} aria-hidden="true" {...props} />;
}

export function PageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-48 items-center justify-center gap-2 text-sm text-fg-secondary">
      <Spinner label={label} />
      <span aria-hidden="true">{label}…</span>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      {icon && <div className="text-fg-muted [&_svg]:size-8">{icon}</div>}
      <div className="space-y-1">
        <p className="font-medium text-fg">{title}</p>
        {description && <p className="max-w-md text-sm text-fg-secondary">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-fg-secondary">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const calloutTones = {
  info: { icon: Info, className: 'border-primary/30 bg-primary-wash', iconClass: 'text-primary' },
  success: { icon: CheckCircle2, className: 'border-success/30 bg-success-wash', iconClass: 'text-success' },
  warning: { icon: AlertTriangle, className: 'border-warning/40 bg-warning-wash', iconClass: 'text-warning' },
  danger: { icon: XCircle, className: 'border-danger/30 bg-danger-wash', iconClass: 'text-danger' },
} as const;

export function Callout({
  tone = 'info',
  title,
  children,
  className,
  action,
}: {
  tone?: keyof typeof calloutTones;
  title?: string;
  children?: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const { icon: Icon, className: toneClass, iconClass } = calloutTones[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={cn('flex gap-3 rounded-lg border p-3 text-sm text-fg', toneClass, className)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', iconClass)} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-fg-secondary">{children}</div>}
        {action && <div className="pt-1">{action}</div>}
      </div>
    </div>
  );
}

export function SectionTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-sm font-semibold text-fg', className)} {...props} />;
}

/** Accessible segmented control (radio group). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'md',
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode; icon?: ReactNode }[];
  label: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-wash p-0.5">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md font-medium text-fg-secondary transition-colors hover:text-fg [&_svg]:size-3.5',
              size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm',
              selected && 'bg-surface text-fg shadow-sm',
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
