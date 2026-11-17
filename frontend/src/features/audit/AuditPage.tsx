import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { ChevronRight, Download, ScrollText, X } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { exportAudit, listAudit, listSources } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import type { AuditAction, AuditEntry, AuditFilters, AuditOutcome } from '@/api/types';
import { SourceChip } from '@/components/SourceBits';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Callout, EmptyState, PageHeader, Skeleton } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { filenameFromDisposition, saveBlob } from '@/lib/download';
import { formatDateTime, formatDuration, formatNumber } from '@/lib/format';

const ACTION_LABELS: Record<AuditAction, string> = {
  query: 'Asked a question',
  refresh: 'Refreshed an answer',
  export: 'Exported data',
  login: 'Signed in',
  logout: 'Signed out',
  source_created: 'Added a data source',
  source_updated: 'Changed a data source',
  source_deleted: 'Removed a data source',
  role_changed: 'Changed roles',
  access_requested: 'Requested access',
  access_decision: 'Decided an access request',
  cache_cleared: 'Cleared the cache',
};

const OUTCOME_TONES: Record<AuditOutcome, BadgeTone> = {
  success: 'success',
  denied: 'danger',
  error: 'warning',
  cancelled: 'neutral',
};

const PAGE_SIZE = 25;

function readFilters(params: URLSearchParams): AuditFilters {
  const range = params.get('range');
  return {
    q: params.get('q') ?? '',
    user: params.get('user') ?? '',
    sourceId: params.get('sourceId') ?? '',
    action: (params.get('action') as AuditAction | null) ?? '',
    outcome: (params.get('outcome') as AuditOutcome | null) ?? '',
    range: range === '24h' || range === '30d' || range === '90d' ? range : '7d',
    queryId: params.get('queryId') ?? undefined,
    page: Math.max(1, Number(params.get('page')) || 1),
    pageSize: PAGE_SIZE,
  };
}

export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const [search, setSearch] = useState(filters.q ?? '');
  const [expanded, setExpanded] = useState<string | null>(null);

  const audit = useQuery({
    queryKey: qk.audit(filters),
    queryFn: () => listAudit(filters),
    placeholderData: keepPreviousData,
  });
  const sources = useQuery({ queryKey: qk.sources, queryFn: listSources, staleTime: 60_000 });

  const setFilter = (key: keyof AuditFilters, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const exportMutation = useMutation({
    mutationFn: () => exportAudit({ ...filters, page: undefined, pageSize: undefined }),
    onSuccess: ({ blob, disposition }) => {
      saveBlob(blob, filenameFromDisposition(disposition, 'codelens-audit.csv'));
      toast.success('Audit log exported', { description: 'The export itself was recorded in the audit log.' });
    },
    onError: (error) => toast.error("Couldn't export the audit log", { description: errorMessage(error) }),
  });

  const totalPages = audit.data ? Math.max(1, Math.ceil(audit.data.total / PAGE_SIZE)) : 1;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6">
      <PageHeader
        title="Audit log"
        description="Every question, export and administrative change, with who did it and when. Entries cannot be edited or deleted."
        actions={
          <Button variant="outline" onClick={() => exportMutation.mutate()} disabled={exportMutation.isPending}>
            <Download aria-hidden="true" /> {exportMutation.isPending ? 'Exporting…' : 'Export CSV'}
          </Button>
        }
      />

      <form
        className="grid gap-2 rounded-xl border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-6"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter('q', search.trim());
        }}
        aria-label="Filter audit log"
      >
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onBlur={() => search.trim() !== (filters.q ?? '') && setFilter('q', search.trim())}
          placeholder="Search questions"
          aria-label="Search questions"
          className="lg:col-span-2"
        />
        <Input
          defaultValue={filters.user}
          onBlur={(event) => event.target.value.trim() !== filters.user && setFilter('user', event.target.value.trim())}
          onKeyDown={(event) => event.key === 'Enter' && setFilter('user', event.currentTarget.value.trim())}
          placeholder="Person (name or email)"
          aria-label="Filter by person"
        />
        <Select value={filters.sourceId} onChange={(event) => setFilter('sourceId', event.target.value)} aria-label="Filter by data source">
          <option value="">All data sources</option>
          {sources.data?.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </Select>
        <Select value={filters.action} onChange={(event) => setFilter('action', event.target.value)} aria-label="Filter by action">
          <option value="">All actions</option>
          {Object.entries(ACTION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <div className="flex gap-2">
          <Select value={filters.outcome} onChange={(event) => setFilter('outcome', event.target.value)} aria-label="Filter by outcome">
            <option value="">Any outcome</option>
            <option value="success">Success</option>
            <option value="denied">Denied</option>
            <option value="error">Error</option>
            <option value="cancelled">Cancelled</option>
          </Select>
          <Select value={filters.range} onChange={(event) => setFilter('range', event.target.value)} aria-label="Time range">
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
            <option value="90d">90 days</option>
          </Select>
        </div>
      </form>

      {filters.queryId && (
        <div className="flex items-center gap-2 text-sm">
          <Badge tone="primary">Showing one question: {filters.queryId}</Badge>
          <Button variant="ghost" size="sm" onClick={() => setFilter('queryId', '')}>
            <X aria-hidden="true" /> Clear
          </Button>
        </div>
      )}

      {audit.isPending ? (
        <Skeleton className="h-96" />
      ) : audit.isError ? (
        <Callout tone="danger">{errorMessage(audit.error)}</Callout>
      ) : audit.data.items.length === 0 ? (
        <EmptyState icon={<ScrollText />} title="No matching entries" description="Try a wider time range or fewer filters." />
      ) : (
        <div className={cn('overflow-x-auto rounded-xl border border-line bg-surface', audit.isFetching && 'opacity-70')}>
          <table className="w-full text-sm">
            <caption className="sr-only">Audit log entries</caption>
            <thead className="bg-wash text-left text-xs text-fg-secondary">
              <tr>
                <th scope="col" className="w-8 px-2 py-2.5">
                  <span className="sr-only">Details</span>
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  When
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  Who
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  What
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  Data sources
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  Outcome
                </th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">
                  Rows
                </th>
              </tr>
            </thead>
            <tbody>
              {audit.data.items.map((entry) => (
                <AuditRow
                  key={entry.id}
                  entry={entry}
                  expanded={expanded === entry.id}
                  onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {audit.data && audit.data.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-fg-secondary">
          <span>
            {formatNumber((filters.page! - 1) * PAGE_SIZE + 1)}–{formatNumber(Math.min(filters.page! * PAGE_SIZE, audit.data.total))} of{' '}
            {formatNumber(audit.data.total)}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={filters.page! <= 1} onClick={() => setFilter('page', String(filters.page! - 1))}>
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page! >= totalPages}
              onClick={() => setFilter('page', String(filters.page! + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AuditRow({ entry, expanded, onToggle }: { entry: AuditEntry; expanded: boolean; onToggle: () => void }) {
  const detailsId = `audit-${entry.id}`;
  return (
    <Fragment>
      <tr className="border-t border-line align-top hover:bg-wash/50">
        <td className="px-2 py-2.5">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={expanded ? 'Hide details' : 'Show details'}
            className="rounded p-0.5 text-fg-secondary hover:bg-line"
          >
            <ChevronRight className={cn('size-4 transition-transform', expanded && 'rotate-90')} />
          </button>
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-fg-secondary">{formatDateTime(entry.timestamp)}</td>
        <td className="px-3 py-2.5">
          <p className="font-medium">{entry.user.name}</p>
          <p className="text-xs text-fg-secondary">{entry.user.email}</p>
        </td>
        <td className="max-w-md px-3 py-2.5">
          <p>{ACTION_LABELS[entry.action]}</p>
          {entry.question && <p className="line-clamp-2 text-xs text-fg-secondary">“{entry.question}”</p>}
        </td>
        <td className="px-3 py-2.5">
          <div className="flex flex-wrap gap-1">
            {entry.sources.length === 0 ? <span className="text-fg-muted">—</span> : entry.sources.map((source) => <SourceChip key={source.id} source={source} />)}
          </div>
        </td>
        <td className="px-3 py-2.5">
          <Badge tone={OUTCOME_TONES[entry.outcome]} className="capitalize">
            {entry.outcome}
          </Badge>
          {entry.cached && (
            <Badge tone="outline" className="ml-1">
              Cached
            </Badge>
          )}
        </td>
        <td className="px-3 py-2.5 text-right tabular">{entry.rowsReturned !== undefined ? formatNumber(entry.rowsReturned) : '—'}</td>
      </tr>
      {expanded && (
        <tr id={detailsId} className="bg-wash/40">
          <td />
          <td colSpan={6} className="space-y-3 px-3 pb-4 pt-1">
            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[9rem_1fr]">
              <dt className="text-fg-secondary">Entry ID</dt>
              <dd className="font-mono">{entry.id}</dd>
              {entry.queryId && (
                <>
                  <dt className="text-fg-secondary">Question ID</dt>
                  <dd className="font-mono">{entry.queryId}</dd>
                </>
              )}
              {entry.durationMs !== undefined && (
                <>
                  <dt className="text-fg-secondary">Duration</dt>
                  <dd>{formatDuration(entry.durationMs)}</dd>
                </>
              )}
              {entry.ipAddress && (
                <>
                  <dt className="text-fg-secondary">IP address</dt>
                  <dd className="font-mono">{entry.ipAddress}</dd>
                </>
              )}
              {entry.details && (
                <>
                  <dt className="text-fg-secondary">Details</dt>
                  <dd>{entry.details}</dd>
                </>
              )}
            </dl>
            {entry.question && (
              <div>
                <p className="mb-1 text-xs font-medium text-fg-secondary">Question</p>
                <p className="text-sm">{entry.question}</p>
              </div>
            )}
            {entry.generatedQueries?.map((query, index) => (
              <div key={index}>
                <p className="mb-1 text-xs font-medium text-fg-secondary">Query run on {query.source.name}</p>
                <pre className="max-h-48 overflow-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs">
                  <code>{query.text}</code>
                </pre>
              </div>
            ))}
          </td>
        </tr>
      )}
    </Fragment>
  );
}
