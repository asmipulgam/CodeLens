import { Ban, Clock, CloudOff, HelpCircle, Lock, RotateCw, ShieldAlert, Timer, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { QueryError, QueryErrorCode, SourceRef } from '@/api/types';
import { SourceChip } from '@/components/SourceBits';
import { Button, buttonClass } from '@/components/ui/button';
import { AccessRequestDialog } from '@/features/shared/AccessRequestDialog';

const ERROR_COPY: Record<QueryErrorCode, { title: string; icon: typeof Lock; retry: boolean }> = {
  forbidden: { title: "You don't have access to this data", icon: Lock, retry: false },
  timeout: { title: 'This question took too long', icon: Timer, retry: true },
  source_offline: { title: 'A data source is offline', icon: CloudOff, retry: true },
  not_understood: { title: "I couldn't understand that question", icon: HelpCircle, retry: false },
  too_large: { title: 'That would return too much data', icon: TriangleAlert, retry: false },
  rate_limited: { title: 'Too many questions at once', icon: Clock, retry: true },
  write_blocked: { title: 'CodeLens can only read data', icon: Ban, retry: false },
  internal: { title: 'Something went wrong', icon: ShieldAlert, retry: true },
};

export function ErrorCard({ error, onRetry }: { error: QueryError; onRetry?: () => void }) {
  const [requesting, setRequesting] = useState<SourceRef | null>(null);
  const copy = ERROR_COPY[error.code] ?? ERROR_COPY.internal;
  const Icon = copy.icon;

  return (
    <section role="alert" className="space-y-3 rounded-xl border border-danger/40 bg-danger-wash/60 p-4">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
        <div className="space-y-1">
          <p className="font-medium">{copy.title}</p>
          <p className="text-sm text-fg-secondary">{error.message}</p>
          {error.hint && <p className="text-sm text-fg-secondary">{error.hint}</p>}
        </div>
      </div>
      {error.source && <SourceChip source={error.source} />}
      <div className="flex flex-wrap gap-2">
        {error.code === 'forbidden' && error.canRequestAccess && error.source && (
          <Button size="sm" onClick={() => setRequesting(error.source ?? null)}>
            Request access
          </Button>
        )}
        {error.code === 'not_understood' && (
          <Link to="/catalog" className={buttonClass({ variant: 'outline', size: 'sm' })}>
            See what you can ask
          </Link>
        )}
        {copy.retry && onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCw aria-hidden="true" /> Try again
          </Button>
        )}
      </div>
      <AccessRequestDialog source={requesting} onOpenChange={(open) => !open && setRequesting(null)} />
    </section>
  );
}
