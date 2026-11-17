import { ChevronDown, Database, Wand2 } from 'lucide-react';
import type { SourceSummary } from '@/api/types';
import { SOURCE_TYPE_LABELS, SourceTypeIcon } from '@/components/SourceBits';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';

interface SourcePickerProps {
  sources: SourceSummary[];
  value: string[];
  onChange: (ids: string[]) => void;
}

/** Lets permitted users pin a question to specific databases. Empty selection = automatic routing. */
export function SourcePicker({ sources, value, onChange }: SourcePickerProps) {
  const available = sources.filter((source) => source.access === 'granted');
  const selected = available.filter((source) => value.includes(source.id));
  const label =
    selected.length === 0 ? 'Auto' : selected.length === 1 ? selected[0].name : `${selected.length} sources`;

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 max-w-52 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-fg-secondary hover:bg-wash hover:text-fg"
          aria-label={`Data sources: ${label}`}
        >
          {selected.length === 0 ? (
            <Wand2 className="size-3.5" aria-hidden="true" />
          ) : (
            <Database className="size-3.5" aria-hidden="true" />
          )}
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2" side="top">
        <button
          type="button"
          onClick={() => onChange([])}
          className={cn(
            'flex w-full items-start gap-2 rounded-md p-2 text-left hover:bg-wash',
            value.length === 0 && 'bg-primary-wash',
          )}
        >
          <Wand2 className="mt-0.5 size-4 text-primary" aria-hidden="true" />
          <span>
            <span className="block text-sm font-medium">Auto (recommended)</span>
            <span className="block text-xs text-fg-secondary">CodeLens picks the right data for each question.</span>
          </span>
        </button>
        <div className="my-1 h-px bg-line" />
        <p className="px-2 py-1 text-xs font-medium text-fg-secondary">Or choose specific sources</p>
        <ul className="max-h-64 overflow-y-auto">
          {available.map((source) => {
            const offline = source.status === 'offline';
            const id = `source-pick-${source.id}`;
            return (
              <li key={source.id}>
                <label
                  htmlFor={id}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-md p-2 hover:bg-wash',
                    offline && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <Checkbox
                    id={id}
                    checked={value.includes(source.id)}
                    disabled={offline}
                    onCheckedChange={() => toggle(source.id)}
                  />
                  <SourceTypeIcon type={source.type} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{source.name}</span>
                    <span className="block text-xs text-fg-secondary">
                      {SOURCE_TYPE_LABELS[source.type]}
                      {offline && ' · Offline'}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
