import { Lock } from 'lucide-react';
import type { CellValue, Column } from '@/api/types';
import { Tip } from '@/components/ui/tooltip';
import { formatCurrency, formatDate, formatDateTime, formatNumber, formatPercent } from '@/lib/format';

export const MASK_TEXT = '••••';

export function MaskedValue() {
  return (
    <Tip content="Hidden by data policy">
      <span tabIndex={0} className="inline-flex items-center gap-1 rounded text-fg-secondary">
        <Lock className="size-3" aria-hidden="true" />
        <span aria-hidden="true">{MASK_TEXT}</span>
        <span className="sr-only">Hidden by data policy</span>
      </span>
    </Tip>
  );
}

export function isNumericColumn(column: Column) {
  return column.type === 'number' || column.type === 'currency' || column.type === 'percent';
}

/** Formats a value as plain text. React escapes it, so database content can never inject markup. */
export function formatCellText(value: CellValue | undefined, column: Column): string {
  if (value === null || value === undefined) return '';
  switch (column.type) {
    case 'number':
      return typeof value === 'number' ? formatNumber(value) : String(value);
    case 'currency':
      return typeof value === 'number' ? formatCurrency(value, column.currency) : String(value);
    case 'percent':
      return typeof value === 'number' ? formatPercent(value) : String(value);
    case 'date':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? formatDate(value) : String(value);
    case 'datetime':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? formatDateTime(value) : String(value);
    case 'boolean':
      return value === true ? 'Yes' : value === false ? 'No' : String(value);
    default:
      return String(value);
  }
}

export function Cell({ value, column }: { value: CellValue | undefined; column: Column }) {
  if (column.masked && (value === null || value === undefined)) return <MaskedValue />;
  if (value === null || value === undefined) return <span className="text-fg-muted">—</span>;
  return <>{formatCellText(value, column)}</>;
}
