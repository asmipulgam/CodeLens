import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown, Lock } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { CellValue, Column } from '@/api/types';
import { cn } from '@/lib/cn';
import { Cell, isNumericColumn } from './cells';

type Row = Record<string, CellValue>;

const ROW_HEIGHT = 36;
const VIRTUALIZE_AFTER = 60;

interface DataTableProps {
  columns: Column[];
  rows: Row[];
  /** Accessible description of the table. */
  caption: string;
  maxHeight?: number;
}

export function DataTable({ columns, rows, caption, maxHeight = 420 }: DataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const columnDefs = useMemo<ColumnDef<Row>[]>(
    () =>
      columns.map((column) => ({
        id: column.key,
        accessorFn: (row) => row[column.key],
        header: column.label,
        enableSorting: !column.masked,
        sortUndefined: 'last',
        meta: column,
        cell: (ctx) => <Cell value={ctx.getValue() as CellValue} column={column} />,
      })),
    [columns],
  );

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const tableRows = table.getRowModel().rows;
  const virtualize = tableRows.length > VIRTUALIZE_AFTER;
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    enabled: virtualize,
  });

  const virtualItems = virtualize ? virtualizer.getVirtualItems() : [];
  const visible = virtualize ? virtualItems.map((item) => tableRows[item.index]) : tableRows;
  const paddingTop = virtualize && virtualItems.length ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualize && virtualItems.length ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0;

  return (
    <div
      ref={scrollRef}
      className="overflow-auto rounded-lg border border-line bg-raised"
      style={{ maxHeight }}
      tabIndex={0}
      role="region"
      aria-label={caption}
    >
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10 bg-wash">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => {
                const column = header.column.columnDef.meta as Column;
                const sorted = header.column.getIsSorted();
                const canSort = header.column.getCanSort();
                const numeric = isNumericColumn(column);
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    className={cn(
                      'whitespace-nowrap border-b border-line px-3 py-2 font-medium text-fg-secondary',
                      numeric ? 'text-right' : 'text-left',
                    )}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn('inline-flex items-center gap-1 hover:text-fg', numeric && 'flex-row-reverse')}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sorted === 'asc' ? (
                          <ArrowUp className="size-3" aria-hidden="true" />
                        ) : sorted === 'desc' ? (
                          <ArrowDown className="size-3" aria-hidden="true" />
                        ) : (
                          <ArrowUpDown className="size-3 opacity-40" aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {column.masked && <Lock className="size-3" aria-label="Hidden by data policy" />}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {paddingTop > 0 && (
            <tr aria-hidden="true">
              <td style={{ height: paddingTop }} colSpan={columns.length} />
            </tr>
          )}
          {visible.map((row) => (
            <tr key={row.id} className="border-b border-line/70 last:border-0 hover:bg-wash/60" style={{ height: ROW_HEIGHT }}>
              {row.getVisibleCells().map((cell) => {
                const column = cell.column.columnDef.meta as Column;
                return (
                  <td
                    key={cell.id}
                    className={cn(
                      'max-w-80 truncate whitespace-nowrap px-3 py-1.5 text-fg',
                      isNumericColumn(column) && 'tabular text-right',
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                );
              })}
            </tr>
          ))}
          {paddingBottom > 0 && (
            <tr aria-hidden="true">
              <td style={{ height: paddingBottom }} colSpan={columns.length} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
