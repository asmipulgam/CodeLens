import { useQuery } from '@tanstack/react-query';
import { BarChart3, Table2, ThumbsDown, TrendingDown, TrendingUp } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { errorMessage } from '@/api/client';
import { adminGetMetrics } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import type { FeedbackReason, MetricsRange, UsageMetrics, UsageTotals } from '@/api/types';
import { ChartLegend, ChartTooltip, axisProps, endLabel, gridProps, seriesColor, type LegendItem } from '@/components/charts';
import { RelativeTime } from '@/components/RelativeTime';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Callout, EmptyState, PageHeader, Segmented, Skeleton } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { formatCompact, formatDuration, formatNumber, formatPercent } from '@/lib/format';

const REASON_LABELS: Record<FeedbackReason, string> = {
  wrong_numbers: 'Wrong numbers',
  wrong_source: 'Wrong data',
  did_not_answer: "Didn't answer",
  too_slow: 'Too slow',
  other: 'Other',
};

function shortDate(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface TileDef {
  key: keyof UsageTotals;
  label: string;
  format: (value: number) => string;
  /** Whether an increase is good news. */
  upIsGood: boolean;
}

const TILES: TileDef[] = [
  { key: 'questions', label: 'Questions asked', format: formatNumber, upIsGood: true },
  { key: 'activeUsers', label: 'Active people', format: formatNumber, upIsGood: true },
  { key: 'cacheHitRate', label: 'Answered from cache', format: (v) => formatPercent(v), upIsGood: true },
  { key: 'p95LatencyMs', label: 'Slowest answers (p95)', format: formatDuration, upIsGood: false },
  { key: 'failedQueries', label: 'Failed questions', format: formatNumber, upIsGood: false },
];

function StatTile({ tile, totals, previous, rangeLabel }: { tile: TileDef; totals: UsageTotals; previous: UsageTotals; rangeLabel: string }) {
  const value = totals[tile.key];
  const before = previous[tile.key];
  const change = before === 0 ? null : (value - before) / before;
  const up = (change ?? 0) > 0;
  const good = change === null || Math.abs(change) < 0.005 ? null : up === tile.upIsGood;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-sm text-fg-secondary">{tile.label}</p>
      <p className="mt-1 text-2xl font-semibold">{tile.format(value)}</p>
      {change !== null && (
        <p
          className={cn(
            'mt-1 flex items-center gap-1 text-xs',
            good === true && 'text-success',
            good === false && 'text-danger',
            good === null && 'text-fg-secondary',
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          {up ? '+' : ''}
          {formatPercent(change, 0)} <span className="text-fg-secondary">vs previous {rangeLabel}</span>
        </p>
      )}
    </div>
  );
}

function ChartCard({ title, description, chart, table }: { title: string; description?: string; chart: ReactNode; table: ReactNode }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <p className="text-sm text-fg-secondary">{description}</p>}
        </div>
        <Segmented
          label={`${title} view`}
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'chart', label: 'Chart', icon: <BarChart3 /> },
            { value: 'table', label: 'Table', icon: <Table2 /> },
          ]}
        />
      </CardHeader>
      <CardContent>{view === 'chart' ? chart : <div className="max-h-72 overflow-auto">{table}</div>}</CardContent>
    </Card>
  );
}

function SimpleTable({ caption, headers, rows }: { caption: string; headers: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="sticky top-0 bg-surface text-left text-xs text-fg-secondary">
        <tr>
          {headers.map((header, index) => (
            <th key={header} scope="col" className={cn('pb-2 font-medium', index > 0 && 'text-right')}>
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex} className="border-t border-line/70">
            {row.map((cell, index) => (
              <td key={index} className={cn('py-1.5', index > 0 && 'text-right tabular')}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Charts({ metrics }: { metrics: UsageMetrics }) {
  const daily = metrics.daily.map((day) => ({ ...day, label: shortDate(day.date) }));
  const volumeSeries: LegendItem[] = [
    { key: 'live', label: 'Live', color: seriesColor(0) },
    { key: 'cached', label: 'From cache', color: seriesColor(1) },
  ];
  const latencySeries: LegendItem[] = [
    { key: 'p50LatencyMs', label: 'Typical (p50)', color: seriesColor(0), shape: 'line' },
    { key: 'p95LatencyMs', label: 'Slowest (p95)', color: seriesColor(1), shape: 'line' },
  ];
  const sourceSeries: LegendItem[] = [{ key: 'questions', label: 'Questions', color: seriesColor(0) }];
  const bySource = metrics.topSources.map((item) => ({ name: item.source.name, questions: item.questions }));
  const last = daily.length - 1;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ChartCard
        title="Questions per day"
        description="Split by whether the answer came live from the database or from the cache."
        chart={
          <div className="space-y-2">
            <ChartLegend items={volumeSeries} />
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={daily} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="label" {...axisProps} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis {...axisProps} axisLine={false} width={48} tickFormatter={formatCompact} />
                  <Tooltip
                    cursor={{ fill: 'var(--chart-grid)', opacity: 0.5 }}
                    content={(props) => <ChartTooltip {...props} series={volumeSeries} formatValue={(v) => formatNumber(v)} />}
                  />
                  {/* Surface-coloured stroke = the 2px gap between stacked segments. */}
                  <Bar dataKey="live" stackId="q" fill={seriesColor(0)} stroke="var(--chart-surface)" strokeWidth={2} maxBarSize={24} isAnimationActive={false} />
                  <Bar dataKey="cached" stackId="q" fill={seriesColor(1)} stroke="var(--chart-surface)" strokeWidth={2} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        }
        table={
          <SimpleTable
            caption="Questions per day"
            headers={['Date', 'Live', 'From cache', 'Failed']}
            rows={daily.map((day) => [day.label, formatNumber(day.live), formatNumber(day.cached), formatNumber(day.failed)])}
          />
        }
      />

      <ChartCard
        title="Response time"
        description="How long people wait for an answer."
        chart={
          <div className="space-y-2">
            <ChartLegend items={latencySeries} />
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={daily} margin={{ top: 8, right: 104, bottom: 0, left: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="label" {...axisProps} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis {...axisProps} axisLine={false} width={56} tickFormatter={(v: number) => formatDuration(v)} />
                  <Tooltip
                    cursor={{ stroke: 'var(--chart-axis)', strokeWidth: 1 }}
                    content={(props) => <ChartTooltip {...props} series={latencySeries} formatValue={(v) => formatDuration(v)} />}
                  />
                  {latencySeries.map((item) => (
                    <Line
                      key={item.key}
                      dataKey={item.key}
                      type="monotone"
                      stroke={item.color}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 5, fill: item.color, stroke: 'var(--chart-surface)', strokeWidth: 2 }}
                      isAnimationActive={false}
                    >
                      <LabelList dataKey={item.key} content={endLabel(last, item.label)} />
                    </Line>
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        }
        table={
          <SimpleTable
            caption="Response time by day"
            headers={['Date', 'Typical (p50)', 'Slowest (p95)']}
            rows={daily.map((day) => [day.label, formatDuration(day.p50LatencyMs), formatDuration(day.p95LatencyMs)])}
          />
        }
      />

      <ChartCard
        title="Questions by data source"
        chart={
          <div style={{ height: Math.max(160, bySource.length * 40) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bySource} layout="vertical" margin={{ top: 0, right: 48, bottom: 0, left: 0 }}>
                <CartesianGrid {...gridProps} horizontal={false} vertical />
                <XAxis type="number" {...axisProps} tickFormatter={formatCompact} />
                <YAxis type="category" dataKey="name" {...axisProps} axisLine={false} width={150} />
                <Tooltip
                  cursor={{ fill: 'var(--chart-grid)', opacity: 0.5 }}
                  content={(props) => <ChartTooltip {...props} series={sourceSeries} formatValue={(v) => formatNumber(v)} />}
                />
                <Bar dataKey="questions" fill={seriesColor(0)} maxBarSize={24} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                  <LabelList
                    dataKey="questions"
                    position="right"
                    fill="var(--chart-text)"
                    fontSize={12}
                    formatter={(value: unknown) => (typeof value === 'number' ? formatCompact(value) : '')}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        }
        table={
          <SimpleTable
            caption="Questions by data source"
            headers={['Data source', 'Questions']}
            rows={bySource.map((item) => [item.name, formatNumber(item.questions)])}
          />
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ThumbsDown className="size-4" aria-hidden="true" /> Reported problems
          </CardTitle>
          <p className="text-sm text-fg-secondary">Answers people flagged as wrong. Review them to improve descriptions.</p>
        </CardHeader>
        <CardContent>
          {metrics.negativeFeedback.length === 0 ? (
            <EmptyState title="No problems reported" className="py-6" />
          ) : (
            <ul className="max-h-72 space-y-3 overflow-y-auto">
              {metrics.negativeFeedback.map((item) => (
                <li key={item.id} className="space-y-1 border-b border-line pb-3 last:border-0">
                  <p className="text-sm font-medium">{item.question}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-fg-secondary">
                    <Badge tone="danger">{REASON_LABELS[item.reason]}</Badge>
                    <span>{item.user}</span>
                    <span>·</span>
                    <RelativeTime iso={item.createdAt} />
                    <Link to={`/audit?queryId=${encodeURIComponent(item.queryId)}`} className="ml-auto text-primary hover:underline">
                      View in audit log
                    </Link>
                  </div>
                  {item.comment && <p className="text-sm text-fg-secondary">“{item.comment}”</p>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function UsagePage() {
  const [range, setRange] = useState<MetricsRange>('7d');
  const metrics = useQuery({ queryKey: qk.admin.metrics(range), queryFn: () => adminGetMetrics(range) });
  const rangeLabel = range === '7d' ? '7 days' : '30 days';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage"
        description="How CodeLens is being used and how well it's answering."
        actions={
          <Segmented
            label="Time range"
            value={range}
            onChange={setRange}
            options={[
              { value: '7d', label: 'Last 7 days' },
              { value: '30d', label: 'Last 30 days' },
            ]}
          />
        }
      />
      {metrics.isPending ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
            {TILES.map((tile) => (
              <Skeleton key={tile.key} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-80" />
        </div>
      ) : metrics.isError ? (
        <Callout tone="danger">{errorMessage(metrics.error)}</Callout>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
            {TILES.map((tile) => (
              <StatTile key={tile.key} tile={tile} totals={metrics.data.totals} previous={metrics.data.previous} rangeLabel={rangeLabel} />
            ))}
          </div>
          <Charts metrics={metrics.data} />
        </>
      )}
    </div>
  );
}
