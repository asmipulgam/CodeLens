import { BookOpen, Clock, Lock, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { SourceRef, SourceSummary } from '@/api/types';
import { HealthBadge, SOURCE_TYPE_LABELS, SourceTypeIcon } from '@/components/SourceBits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Callout, EmptyState, PageHeader, Skeleton } from '@/components/ui/misc';
import { AccessRequestDialog } from '@/features/shared/AccessRequestDialog';
import { useSources } from '@/features/shared/hooks';

export function CatalogPage() {
  const sources = useSources();
  const [search, setSearch] = useState('');
  const [requesting, setRequesting] = useState<SourceRef | null>(null);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const items = sources.data ?? [];
    if (!term) return items;
    return items.filter(
      (source) =>
        source.name.toLowerCase().includes(term) ||
        source.description.toLowerCase().includes(term) ||
        SOURCE_TYPE_LABELS[source.type].toLowerCase().includes(term),
    );
  }, [sources.data, search]);

  const granted = filtered.filter((source) => source.access === 'granted');
  const other = filtered.filter((source) => source.access !== 'granted');

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <PageHeader
        title="What can I ask?"
        description="These are the company data sources CodeLens can answer questions from. Open one to see what it contains, example questions and what business terms mean."
      />
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-fg-muted" aria-hidden="true" />
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search data sources"
          aria-label="Search data sources"
          className="pl-8"
        />
      </div>

      {sources.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-40" />
          ))}
        </div>
      ) : sources.isError ? (
        <Callout tone="danger" title="Couldn't load data sources">
          Please refresh the page or try again later.
        </Callout>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<BookOpen />} title="No data sources match your search" />
      ) : (
        <>
          {granted.length > 0 && (
            <section className="space-y-3" aria-labelledby="available-title">
              <h2 id="available-title" className="text-sm font-semibold">
                Available to you
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {granted.map((source) => (
                  <SourceCard key={source.id} source={source} />
                ))}
              </div>
            </section>
          )}
          {other.length > 0 && (
            <section className="space-y-3" aria-labelledby="other-title">
              <h2 id="other-title" className="text-sm font-semibold">
                Other data sources
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {other.map((source) => (
                  <SourceCard key={source.id} source={source} onRequest={() => setRequesting(source)} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
      <AccessRequestDialog source={requesting} onOpenChange={(open) => !open && setRequesting(null)} />
    </div>
  );
}

function SourceCard({ source, onRequest }: { source: SourceSummary; onRequest?: () => void }) {
  const granted = source.access === 'granted';
  const content = (
    <>
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-wash">
          <SourceTypeIcon type={source.type} className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium">{source.name}</h3>
          <p className="text-xs text-fg-secondary">{SOURCE_TYPE_LABELS[source.type]}</p>
        </div>
        {granted ? (
          <HealthBadge status={source.status} />
        ) : source.access === 'pending' ? (
          <Badge tone="warning">
            <Clock aria-hidden="true" /> Requested
          </Badge>
        ) : (
          <Badge>
            <Lock aria-hidden="true" /> No access
          </Badge>
        )}
      </div>
      <p className="line-clamp-3 text-sm text-fg-secondary">{source.description}</p>
    </>
  );

  if (granted) {
    return (
      <Link
        to={`/catalog/${encodeURIComponent(source.id)}`}
        className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-sm transition-colors hover:border-primary"
      >
        {content}
      </Link>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-dashed border-line-strong bg-surface/60 p-4">
      {content}
      {source.access === 'none' && onRequest && (
        <Button variant="outline" size="sm" className="self-start" onClick={onRequest}>
          Request access
        </Button>
      )}
    </div>
  );
}
