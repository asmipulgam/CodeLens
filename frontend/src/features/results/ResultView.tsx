import { BarChart3, Table2 } from 'lucide-react';
import { Suspense, lazy, useState } from 'react';
import type { ChartSpec, ResultSet, SingleResult } from '@/api/types';
import { SourceTypeIcon } from '@/components/SourceBits';
import { Segmented, Skeleton } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatNumber } from '@/lib/format';
import { DataTable } from './DataTable';
import { DocumentsView } from './DocumentsView';
import { RedisView } from './RedisView';

// The charting library is large; load it only when a chart is shown.
const ResultChart = lazy(() => import('./ResultChart').then((m) => ({ default: m.ResultChart })));

export function rowsShown(result: SingleResult): number {
  if (result.kind === 'table') return result.rows.length;
  if (result.kind === 'documents') return result.documents.length;
  return result.entries.length;
}

function SingleResultView({ result, chart, caption }: { result: SingleResult; chart?: ChartSpec; caption: string }) {
  const [view, setView] = useState<'chart' | 'table'>(chart ? 'chart' : 'table');

  if (result.kind === 'documents') return <DocumentsView result={result} caption={caption} />;
  if (result.kind === 'keyvalue') return <RedisView result={result} />;

  return (
    <div className="space-y-2">
      {chart && (
        <div className="flex justify-end">
          <Segmented
            label="Show as"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: 'chart', label: 'Chart', icon: <BarChart3 /> },
              { value: 'table', label: 'Table', icon: <Table2 /> },
            ]}
          />
        </div>
      )}
      {chart && view === 'chart' ? (
        <Suspense fallback={<Skeleton className="h-72" />}>
          <ResultChart spec={chart} result={result} title={caption} />
        </Suspense>
      ) : (
        <DataTable columns={result.columns} rows={result.rows} caption={caption} />
      )}
    </div>
  );
}

function TruncationNote({ result }: { result: SingleResult }) {
  const shown = rowsShown(result);
  if (shown >= result.totalRows) return null;
  return (
    <p className="text-xs text-fg-secondary">
      Showing {formatNumber(shown)} of {formatNumber(result.totalRows)} rows. Add a filter (like a date range or region)
      to narrow it down.
    </p>
  );
}

export function ResultView({ result, chart, caption }: { result: ResultSet; chart?: ChartSpec; caption: string }) {
  if (result.kind !== 'multi') {
    return (
      <div className="space-y-2">
        <SingleResultView result={result} chart={chart} caption={caption} />
        <TruncationNote result={result} />
      </div>
    );
  }

  const first = result.parts[0];
  if (!first) return null;
  return (
    <Tabs defaultValue={first.source.id}>
      <TabsList aria-label="Results by data source">
        {result.parts.map((part) => (
          <TabsTrigger key={part.source.id} value={part.source.id}>
            <SourceTypeIcon type={part.source.type} />
            {part.source.name}
          </TabsTrigger>
        ))}
      </TabsList>
      {result.parts.map((part) => (
        <TabsContent key={part.source.id} value={part.source.id} className="mt-3 space-y-2">
          <SingleResultView result={part.result} caption={`${caption} — ${part.source.name}`} />
          <TruncationNote result={part.result} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
