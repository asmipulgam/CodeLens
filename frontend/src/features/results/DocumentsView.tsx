import { Braces, Table2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { DocumentsResult } from '@/api/types';
import { Segmented } from '@/components/ui/misc';
import { DataTable } from './DataTable';
import { documentsToTable } from './flatten';
import { JsonTree } from './JsonTree';

export function DocumentsView({ result, caption }: { result: DocumentsResult; caption: string }) {
  const [view, setView] = useState<'table' | 'json'>('table');
  const table = useMemo(() => documentsToTable(result.documents, result.maskedPaths), [result]);
  const masked = useMemo(() => new Set(result.maskedPaths), [result.maskedPaths]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-fg-secondary">
          {result.documents.length} document{result.documents.length === 1 ? '' : 's'}. Nested fields are shown as
          columns like <code className="font-mono">shipping.status</code>.
        </p>
        <Segmented
          label="Document view"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'table', label: 'Table', icon: <Table2 /> },
            { value: 'json', label: 'Documents', icon: <Braces /> },
          ]}
        />
      </div>
      {view === 'table' ? (
        <>
          <DataTable columns={table.columns} rows={table.rows} caption={caption} />
          {table.hiddenColumnCount > 0 && (
            <p className="text-xs text-fg-secondary">
              {table.hiddenColumnCount} more fields are available in the Documents view.
            </p>
          )}
        </>
      ) : (
        <div
          className="max-h-[420px] space-y-3 overflow-auto rounded-lg border border-line bg-raised p-3 font-mono text-xs"
          tabIndex={0}
          role="region"
          aria-label={caption}
        >
          {result.documents.map((doc, index) => (
            <div key={index} className="border-b border-line pb-2 last:border-0">
              <JsonTree value={doc} maskedPaths={masked} name={`#${index + 1}`} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
