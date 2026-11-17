import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, MoreHorizontal, Pencil, Plus, Power, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { adminCheckSource, adminDeleteSource, adminListSources, adminSetSourceEnabled } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import type { AdminSource } from '@/api/types';
import { RelativeTime } from '@/components/RelativeTime';
import { HealthBadge, SOURCE_TYPE_LABELS, SourceTypeIcon } from '@/components/SourceBits';
import { Badge } from '@/components/ui/badge';
import { buttonClass } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Callout, EmptyState, PageHeader, Skeleton } from '@/components/ui/misc';
import { formatSecondsShort } from '@/lib/format';

export function SourcesPage() {
  const sources = useQuery({ queryKey: qk.admin.sources, queryFn: adminListSources });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Data sources"
        description="Databases CodeLens can answer questions from. Each connection uses a read-only account and only exposes the tables and fields you choose."
        actions={
          <Link to="/admin/sources/new" className={buttonClass()}>
            <Plus aria-hidden="true" /> Add data source
          </Link>
        }
      />

      {sources.isPending ? (
        <Skeleton className="h-64" />
      ) : sources.isError ? (
        <Callout tone="danger" title="Couldn't load data sources">
          {errorMessage(sources.error)}
        </Callout>
      ) : sources.data.length === 0 ? (
        <EmptyState
          icon={<Database />}
          title="No data sources yet"
          description="Connect your first database so people can start asking questions."
          action={
            <Link to="/admin/sources/new" className={buttonClass()}>
              Add data source
            </Link>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <caption className="sr-only">Connected data sources</caption>
            <thead className="bg-wash text-left text-xs text-fg-secondary">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Type
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Last checked
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Exposed
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Cache
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Owner
                </th>
                <th scope="col" className="px-4 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sources.data.map((source) => (
                <SourceRow key={source.id} source={source} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SourceRow({ source }: { source: AdminSource }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.admin.sources });
    void qc.invalidateQueries({ queryKey: qk.sources });
  };

  const check = useMutation({
    mutationFn: () => adminCheckSource(source.id),
    onSuccess: (updated) => {
      invalidate();
      toast.success(`${source.name}: ${updated.status}`);
    },
    onError: (error) => toast.error('Health check failed', { description: errorMessage(error) }),
  });

  const toggle = useMutation({
    mutationFn: () => adminSetSourceEnabled(source.id, !source.enabled),
    onSuccess: () => {
      invalidate();
      toast.success(source.enabled ? `${source.name} disabled` : `${source.name} enabled`);
    },
    onError: (error) => toast.error("Couldn't change status", { description: errorMessage(error) }),
  });

  const remove = useMutation({
    mutationFn: () => adminDeleteSource(source.id),
    onSuccess: () => {
      invalidate();
      setConfirmDelete(false);
      toast.success(`${source.name} removed`, { description: 'Its stored credentials were deleted.' });
    },
    onError: (error) => toast.error("Couldn't remove data source", { description: errorMessage(error) }),
  });

  return (
    <tr className="border-t border-line align-top">
      <td className="px-4 py-3">
        <Link to={`/admin/sources/${encodeURIComponent(source.id)}`} className="font-medium hover:text-primary hover:underline">
          {source.name}
        </Link>
        <p className="line-clamp-1 max-w-xs text-xs text-fg-secondary">{source.description}</p>
        {!source.enabled && (
          <Badge tone="neutral" className="mt-1">
            Disabled
          </Badge>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <span className="inline-flex items-center gap-1.5">
          <SourceTypeIcon type={source.type} />
          {SOURCE_TYPE_LABELS[source.type]}
        </span>
      </td>
      <td className="px-4 py-3">
        <HealthBadge status={source.status} />
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-fg-secondary">
        <RelativeTime iso={source.lastCheckedAt} />
      </td>
      <td className="whitespace-nowrap px-4 py-3 tabular">{source.exposedCount}</td>
      <td className="whitespace-nowrap px-4 py-3">{formatSecondsShort(source.cacheTtlSeconds)}</td>
      <td className="whitespace-nowrap px-4 py-3 text-fg-secondary">{source.owner}</td>
      <td className="px-4 py-3 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="rounded-md p-1.5 text-fg-secondary hover:bg-wash hover:text-fg"
              aria-label={`Actions for ${source.name}`}
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => navigate(`/admin/sources/${encodeURIComponent(source.id)}`)}>
              <Pencil /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => check.mutate()} disabled={check.isPending}>
              <RefreshCw /> Check health now
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => toggle.mutate()} disabled={toggle.isPending}>
              <Power /> {source.enabled ? 'Disable' : 'Enable'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => setConfirmDelete(true)}>
              <Trash2 /> Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Remove ${source.name}?`}
          description="People will no longer be able to ask questions about this data. Stored credentials are deleted. Audit history is kept."
          confirmLabel="Remove data source"
          destructive
          requireText={source.name}
          busy={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </td>
    </tr>
  );
}
