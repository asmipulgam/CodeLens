import { useMemo } from 'react';
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
import type { ChartSpec, Column, TableResult } from '@/api/types';
import {
  ChartLegend,
  ChartTooltip,
  MAX_SERIES,
  axisProps,
  endLabel,
  gridProps,
  seriesColor,
  type LegendItem,
} from '@/components/charts';
import { formatCompact, formatCurrencyCompact, formatPercent } from '@/lib/format';
import { formatCellText } from './cells';

function axisFormatter(column: Column | undefined) {
  if (column?.type === 'currency') return (value: number) => formatCurrencyCompact(value, column.currency);
  if (column?.type === 'percent') return (value: number) => formatPercent(value, 0);
  return formatCompact;
}

export function ResultChart({ spec, result, title }: { spec: ChartSpec; result: TableResult; title: string }) {
  const columnsByKey = useMemo(() => new Map(result.columns.map((column) => [column.key, column])), [result.columns]);
  const xColumn = columnsByKey.get(spec.x);
  const seriesKeys = spec.series.filter((key) => columnsByKey.has(key)).slice(0, MAX_SERIES);
  const firstSeries = columnsByKey.get(seriesKeys[0]);

  const series: LegendItem[] = seriesKeys.map((key, index) => ({
    key,
    label: columnsByKey.get(key)?.label ?? key,
    color: seriesColor(index),
    shape: spec.type === 'line' ? 'line' : 'square',
  }));

  const data = useMemo(
    () =>
      result.rows.map((row) => ({
        ...row,
        __x: xColumn ? formatCellText(row[spec.x], xColumn) : String(row[spec.x] ?? ''),
      })),
    [result.rows, spec.x, xColumn],
  );

  const formatAxis = axisFormatter(firstSeries);
  const formatValue = (value: number, key: string) => {
    const column = columnsByKey.get(key);
    return column ? formatCellText(value, column) : String(value);
  };
  const tooltip = (props: object) => <ChartTooltip {...props} series={series} formatValue={formatValue} />;
  const lastIndex = data.length - 1;
  const labelBars = spec.type === 'bar' && series.length === 1 && data.length <= 8;
  const labelLines = spec.type === 'line' && series.length <= 4 && series.length > 1;

  return (
    <figure className="space-y-2" aria-label={title}>
      <ChartLegend items={series} />
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {spec.type === 'bar' ? (
            <BarChart data={data} margin={{ top: 20, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="__x" {...axisProps} interval="preserveStartEnd" />
              <YAxis {...axisProps} axisLine={false} width={64} tickFormatter={formatAxis} />
              <Tooltip content={tooltip} cursor={{ fill: 'var(--chart-grid)', opacity: 0.5 }} />
              {series.map((item) => (
                <Bar
                  key={item.key}
                  dataKey={item.key}
                  name={item.label}
                  fill={item.color}
                  maxBarSize={24}
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                >
                  {labelBars && (
                    <LabelList
                      dataKey={item.key}
                      position="top"
                      fill="var(--chart-text)"
                      fontSize={12}
                      formatter={(value: unknown) => (typeof value === 'number' ? formatAxis(value) : '')}
                    />
                  )}
                </Bar>
              ))}
            </BarChart>
          ) : (
            <LineChart data={data} margin={{ top: 12, right: labelLines ? 96 : 16, bottom: 0, left: 0 }}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="__x" {...axisProps} interval="preserveStartEnd" />
              <YAxis {...axisProps} axisLine={false} width={64} tickFormatter={formatAxis} />
              <Tooltip content={tooltip} cursor={{ stroke: 'var(--chart-axis)', strokeWidth: 1 }} />
              {series.map((item) => (
                <Line
                  key={item.key}
                  dataKey={item.key}
                  name={item.label}
                  type="monotone"
                  stroke={item.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  dot={false}
                  activeDot={{ r: 5, fill: item.color, stroke: 'var(--chart-surface)', strokeWidth: 2 }}
                  isAnimationActive={false}
                >
                  {labelLines && <LabelList dataKey={item.key} content={endLabel(lastIndex, item.label)} />}
                </Line>
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">{title}. The same data is available in the table view.</figcaption>
    </figure>
  );
}
