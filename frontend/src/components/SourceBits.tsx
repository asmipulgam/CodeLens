import { AlertTriangle, CheckCircle2, Database, KeyRound, Leaf, Snowflake, XCircle } from 'lucide-react';
import type { SourceHealth, SourceRef, SourceType } from '@/api/types';
import { cn } from '@/lib/cn';
import { Badge } from './ui/badge';

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  sqlserver: 'SQL Server',
  oracle: 'Oracle',
  snowflake: 'Snowflake',
  mongodb: 'MongoDB',
  redis: 'Redis',
};

const TYPE_ICONS: Record<SourceType, typeof Database> = {
  postgresql: Database,
  mysql: Database,
  sqlserver: Database,
  oracle: Database,
  snowflake: Snowflake,
  mongodb: Leaf,
  redis: KeyRound,
};

export function SourceTypeIcon({ type, className }: { type: SourceType; className?: string }) {
  const Icon = TYPE_ICONS[type];
  return <Icon className={cn('size-4 shrink-0 text-fg-secondary', className)} aria-hidden="true" />;
}

/** Small chip naming a data source and its technology. */
export function SourceChip({ source, className }: { source: SourceRef; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-line bg-wash px-2 py-0.5 text-xs text-fg',
        className,
      )}
    >
      <SourceTypeIcon type={source.type} className="size-3.5" />
      <span className="font-medium">{source.name}</span>
      <span className="text-fg-secondary">· {SOURCE_TYPE_LABELS[source.type]}</span>
    </span>
  );
}

const HEALTH = {
  healthy: { label: 'Healthy', icon: CheckCircle2, color: 'var(--status-good)', tone: 'success' },
  degraded: { label: 'Degraded', icon: AlertTriangle, color: 'var(--status-warning)', tone: 'warning' },
  offline: { label: 'Offline', icon: XCircle, color: 'var(--status-critical)', tone: 'danger' },
} as const;

/** Status always pairs an icon and a label with its color — never color alone. */
export function HealthBadge({ status }: { status: SourceHealth }) {
  const { label, icon: Icon, color, tone } = HEALTH[status];
  return (
    <Badge tone={tone}>
      <Icon style={{ color }} aria-hidden="true" />
      {label}
    </Badge>
  );
}
