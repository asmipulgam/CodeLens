import type { CellValue, Column, ColumnType } from '@/api/types';

const MAX_COLUMNS = 30;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Flattens nested objects into dot paths: { a: { b: 1 } } → { "a.b": 1 }. Arrays stay whole. */
export function flattenDocument(doc: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}) {
  for (const [key, value] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && Object.keys(value).length > 0) flattenDocument(value, path, out);
    else out[path] = value;
  }
  return out;
}

export function summarizeArray(value: unknown[]): string {
  if (value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
    const shown = value.slice(0, 5).map((item) => (item === null ? '—' : String(item)));
    return value.length > 5 ? `${shown.join(', ')} … (+${value.length - 5})` : shown.join(', ');
  }
  return `${value.length} item${value.length === 1 ? '' : 's'}`;
}

function toCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return summarizeArray(value);
  if (typeof value === 'object') return '{}';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function inferType(values: CellValue[]): ColumnType {
  const present = values.filter((value) => value !== null);
  if (present.length === 0) return 'string';
  if (present.every((value) => typeof value === 'number')) return 'number';
  if (present.every((value) => typeof value === 'boolean')) return 'boolean';
  if (present.every((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value))) return 'datetime';
  return 'string';
}

/** Turns MongoDB-style documents into a flat table with one column per dot path. */
export function documentsToTable(documents: Record<string, unknown>[], maskedPaths: string[]) {
  const flat = documents.map((doc) => flattenDocument(doc));
  const keys: string[] = [];
  for (const row of flat) {
    for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
  }
  const masked = new Set(maskedPaths);
  const shownKeys = keys.slice(0, MAX_COLUMNS);
  const rows = flat.map((row) => Object.fromEntries(shownKeys.map((key) => [key, toCell(row[key])])));
  const columns: Column[] = shownKeys.map((key) => ({
    key,
    label: key,
    type: inferType(rows.map((row) => row[key])),
    masked: masked.has(key) || undefined,
  }));
  return { columns, rows, hiddenColumnCount: Math.max(0, keys.length - MAX_COLUMNS) };
}
