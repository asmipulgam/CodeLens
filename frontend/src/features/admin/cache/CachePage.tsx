import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { adminClearCache, adminGetCache, adminSetCacheTtl } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import type { CacheOverview, SourceRef } from '@/api/types';
import { SOURCE_TYPE_LABELS, SourceTypeIcon } from '@/components/SourceBits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Select } from '@/components/ui/input';
import { Callout, PageHeader, Skeleton } from '@/components/ui/misc';
import { formatBytes, formatNumber, formatPercent } from '@/lib/format';
import { CACHE_TTL_OPTIONS } from '../sources/wizardState';

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-sm text-fg-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

export function CachePage() {
  const qc = useQueryClient();
  const cache = useQuery({ queryKey: qk.admin.cache, queryFn: adminGetCache });
  const [clearing, setClearing] = useState<SourceRef | 'all' | null>(null);

  const setTtl = useMutation({
    mutationFn: ({ sourceId, ttl }: { sourceId: string; ttl: number }) => adminSetCacheTtl(sourceId, ttl),
    onSuccess: (overview: CacheOverview) => {
      qc.setQueryData(qk.admin.cache, overview);
      void qc.invalidateQueries({ queryKey: qk.admin.sources });
      toast.success('Cache setting saved');
    },
    onError: (error) => toast.error("Couldn't change the cache setting", { description: errorMessage(error) }),
  });

  const clear = useMutation({
    mutationFn: (sourceId?: string) => adminClearCache(sourceId),
    onSuccess: (overview: CacheOverview) => {
      qc.setQueryData(qk.admin.cache, overview);
      setClearing(null);
      toast.success('Cache cleared', { description: 'The next questions will fetch live data.' });
    },
    onError: (error) => toast.error("Couldn't clear the cache", { description: errorMessage(error) }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Answer cache"
        description="When someone asks a question that was recently answered for a person with the same access, CodeLens reuses that answer instead of querying the database again."
        actions={
          <Button variant="outline" onClick={() => setClearing('all')}>
            <Trash2 aria-hidden="true" /> Clear all
          </Button>
        }
      />

      <Callout tone="info" title="Cached answers never cross permission boundaries">
        Answers are cached separately for each combination of roles and data policies, so nobody can see data through the
        cache that they couldn't query directly. Clearing the cache never deletes database data.
      </Callout>

      {cache.isPending ? (
        <Skeleton className="h-64" />
      ) : cache.isError ? (
        <Callout tone="danger">{errorMessage(cache.error)}</Callout>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile label="Hit rate (last 7 days)" value={formatPercent(cache.data.hitRate)} />
            <StatTile label="Cached answers" value={formatNumber(cache.data.entries)} />
            <StatTile label="Memory used" value={formatBytes(cache.data.sizeBytes)} />
          </div>

          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full text-sm">
              <caption className="sr-only">Cache settings by data source</caption>
              <thead className="bg-wash text-left text-xs text-fg-secondary">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Data source
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Reuse answers for
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">
                    Hit rate
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">
                    Cached answers
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">
                    Size
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {cache.data.sources.map((row) => (
                  <tr key={row.source.id} className="border-t border-line">
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2">
                        <SourceTypeIcon type={row.source.type} />
                        <span>
                          <span className="block font-medium">{row.source.name}</span>
                          <span className="block text-xs text-fg-secondary">{SOURCE_TYPE_LABELS[row.source.type]}</span>
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Select
                        aria-label={`Cache duration for ${row.source.name}`}
                        value={row.ttlSeconds}
                        className="h-8 w-44"
                        onChange={(event) => setTtl.mutate({ sourceId: row.source.id, ttl: Number(event.target.value) })}
                      >
                        {CACHE_TTL_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-4 py-3 text-right tabular">{formatPercent(row.hitRate)}</td>
                    <td className="px-4 py-3 text-right tabular">{formatNumber(row.entries)}</td>
                    <td className="px-4 py-3 text-right tabular">{formatBytes(row.sizeBytes)}</td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="ghost" size="sm" onClick={() => setClearing(row.source)}>
                        Clear
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="flex items-center gap-1.5 text-xs text-fg-secondary">
            <Info className="size-3.5" aria-hidden="true" /> Use short durations for data that changes often, like live
            sessions or stock levels.
          </p>
        </>
      )}

      <ConfirmDialog
        open={clearing !== null}
        onOpenChange={(open) => !open && setClearing(null)}
        title={clearing === 'all' ? 'Clear the entire cache?' : `Clear cached answers for ${clearing?.name ?? ''}?`}
        description="Questions will run against the database again until the cache warms back up. This may be slower for a while."
        confirmLabel="Clear cache"
        destructive
        busy={clear.isPending}
        onConfirm={() => clear.mutate(clearing === 'all' || clearing === null ? undefined : clearing.id)}
      />
    </div>
  );
}
