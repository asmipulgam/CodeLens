import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { MaskedValue } from './cells';

interface JsonTreeProps {
  value: unknown;
  maskedPaths: Set<string>;
  path?: string;
  name?: string;
  depth?: number;
}

function normalizePath(path: string) {
  return path.replace(/\[\d+\]/g, '');
}

function Primitive({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-fg-muted">null</span>;
  if (typeof value === 'string') return <span className="break-all text-fg">"{value}"</span>;
  if (typeof value === 'number') return <span className="text-primary">{value}</span>;
  if (typeof value === 'boolean') return <span className="text-primary">{String(value)}</span>;
  return <span>{String(value)}</span>;
}

/** Read-only, collapsible JSON viewer. All values render as text. */
export function JsonTree({ value, maskedPaths, path = '', name, depth = 0 }: JsonTreeProps) {
  const [open, setOpen] = useState(depth < 2);
  const isMasked = path !== '' && maskedPaths.has(normalizePath(path));
  const label = name !== undefined && <span className="text-fg-secondary">{name}: </span>;

  if (isMasked) {
    return (
      <div className="py-0.5">
        {label}
        <MaskedValue />
      </div>
    );
  }

  if (value === null || typeof value !== 'object') {
    return (
      <div className="py-0.5">
        {label}
        <Primitive value={value} />
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((item, index) => [String(index), item])
    : Object.entries(value as Record<string, unknown>);
  const brackets = isArray ? ['[', ']'] : ['{', '}'];

  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="inline-flex items-center gap-0.5 rounded hover:bg-wash"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} aria-hidden="true" />
        {label}
        <span className="text-fg-secondary">
          {brackets[0]}
          {!open && ` ${entries.length} ${isArray ? 'items' : 'fields'} ${brackets[1]}`}
        </span>
      </button>
      {open && (
        <div className="ml-4 border-l border-line pl-3">
          {entries.map(([key, child]) => (
            <JsonTree
              key={key}
              value={child}
              maskedPaths={maskedPaths}
              name={isArray ? undefined : key}
              path={isArray ? `${path}[${key}]` : path ? `${path}.${key}` : key}
              depth={depth + 1}
            />
          ))}
          <span className="text-fg-secondary">{brackets[1]}</span>
        </div>
      )}
    </div>
  );
}
