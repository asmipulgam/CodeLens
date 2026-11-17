import type { ReactNode } from 'react';

/**
 * Shared chart building blocks. Rules (from the data-viz guide):
 *  - categorical colors are assigned in fixed palette order, never cycled (max 8 series);
 *  - one y-axis only; thin marks; hairline, recessive gridlines;
 *  - a legend whenever there are 2+ series; text uses text colors, never series colors;
 *  - every chart has a hover tooltip and a table view elsewhere on the page.
 */

export const MAX_SERIES = 8;

export function seriesColor(index: number): string {
  return `var(--series-${Math.min(index, MAX_SERIES - 1) + 1})`;
}

export const axisProps = {
  stroke: 'var(--chart-axis)',
  tick: { fill: 'var(--chart-text)', fontSize: 12 },
  tickLine: false,
} as const;

export const gridProps = {
  stroke: 'var(--chart-grid)',
  strokeDasharray: undefined,
  vertical: false,
} as const;

export interface LegendItem {
  key: string;
  label: string;
  color: string;
  shape?: 'square' | 'line';
}

export function ChartLegend({ items }: { items: LegendItem[] }) {
  if (items.length < 2) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-secondary" aria-label="Legend">
      {items.map((item) => (
        <li key={item.key} className="inline-flex items-center gap-1.5">
          {item.shape === 'line' ? (
            <span className="h-0.5 w-3.5 rounded-full" style={{ background: item.color }} aria-hidden="true" />
          ) : (
            <span className="size-2.5 rounded-[3px]" style={{ background: item.color }} aria-hidden="true" />
          )}
          {item.label}
        </li>
      ))}
    </ul>
  );
}

interface TooltipEntry {
  dataKey?: unknown;
  value?: unknown;
}

export interface ChartTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<TooltipEntry>;
  label?: unknown;
}

/** Tooltip body shared by every chart. Pass it to Recharts' `content` prop. */
export function ChartTooltip({
  active,
  payload,
  label,
  series,
  formatValue,
  formatLabel,
}: ChartTooltipProps & {
  series: LegendItem[];
  formatValue: (value: number, key: string) => string;
  formatLabel?: (label: unknown) => ReactNode;
}) {
  if (!active || !payload?.length) return null;
  const byKey = new Map(payload.map((entry) => [String(entry.dataKey), entry.value]));
  return (
    <div className="min-w-36 rounded-lg border border-line bg-raised px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-fg">{formatLabel ? formatLabel(label) : String(label ?? '')}</p>
      <ul className="space-y-0.5">
        {series.map((item) => {
          const value = byKey.get(item.key);
          if (typeof value !== 'number') return null;
          return (
            <li key={item.key} className="flex items-center gap-2 text-fg-secondary">
              <span className="size-2 rounded-[2px]" style={{ background: item.color }} aria-hidden="true" />
              <span className="flex-1">{item.label}</span>
              <span className="tabular font-medium text-fg">{formatValue(value, item.key)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface EndLabelProps {
  x?: number | string;
  y?: number | string;
  index?: number;
}

/** Label drawn only at a line's last point (selective direct labelling). */
export function endLabel(lastIndex: number, text: string) {
  return function EndLabel(props: EndLabelProps) {
    if (props.index !== lastIndex) return null;
    const x = Number(props.x);
    const y = Number(props.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return (
      <text x={x + 8} y={y} dy={4} fontSize={12} fill="var(--chart-text)">
        {text}
      </text>
    );
  };
}
