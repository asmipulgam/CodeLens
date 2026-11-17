import type { KeyValueResult, RedisEntry } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { formatNumber, formatSecondsShort } from '@/lib/format';
import { MaskedValue } from './cells';

const TYPE_LABELS: Record<RedisEntry['type'], string> = {
  string: 'Value',
  hash: 'Fields',
  list: 'List',
  set: 'Set',
  zset: 'Ranked set',
};

const MAX_ITEMS = 50;

function Text({ value }: { value: string | null }) {
  return value === null ? <MaskedValue /> : <span className="break-all">{value}</span>;
}

function EntryValue({ entry }: { entry: RedisEntry }) {
  if (entry.masked) return <MaskedValue />;
  switch (entry.type) {
    case 'string':
      return (
        <p className="font-mono text-sm">
          <Text value={entry.value} />
        </p>
      );
    case 'hash':
      return (
        <table className="w-full text-sm">
          <caption className="sr-only">Fields of {entry.key}</caption>
          <tbody>
            {Object.entries(entry.value).map(([field, value]) => (
              <tr key={field} className="border-b border-line/70 last:border-0">
                <th scope="row" className="w-1/3 py-1 pr-3 text-left font-mono font-normal text-fg-secondary">
                  {field}
                </th>
                <td className="py-1 font-mono">
                  <Text value={value} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'list':
    case 'set': {
      const ListTag = entry.type === 'list' ? 'ol' : 'ul';
      return (
        <ListTag className="list-inside space-y-0.5 font-mono text-sm marker:text-fg-muted">
          {entry.value.slice(0, MAX_ITEMS).map((item, index) => (
            <li key={index} className={entry.type === 'list' ? 'list-decimal' : 'list-disc'}>
              <Text value={item} />
            </li>
          ))}
          {entry.value.length > MAX_ITEMS && (
            <li className="list-none text-xs text-fg-secondary">+{entry.value.length - MAX_ITEMS} more</li>
          )}
        </ListTag>
      );
    }
    case 'zset':
      return (
        <table className="w-full text-sm">
          <caption className="sr-only">Ranked members of {entry.key}</caption>
          <thead>
            <tr className="text-left text-xs text-fg-secondary">
              <th scope="col" className="w-10 pb-1 font-medium">
                #
              </th>
              <th scope="col" className="pb-1 font-medium">
                Member
              </th>
              <th scope="col" className="pb-1 text-right font-medium">
                Score
              </th>
            </tr>
          </thead>
          <tbody>
            {entry.value.slice(0, MAX_ITEMS).map((item, index) => (
              <tr key={item.member} className="border-t border-line/70">
                <td className="py-1 text-fg-secondary tabular">{index + 1}</td>
                <td className="py-1 font-mono">{item.member}</td>
                <td className="py-1 text-right tabular">{formatNumber(item.score)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
}

export function RedisView({ result }: { result: KeyValueResult }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {result.entries.map((entry) => (
        <section key={entry.key} className="space-y-2 rounded-lg border border-line bg-raised p-3" aria-label={entry.key}>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs font-semibold" title={entry.key}>
              {entry.key}
            </code>
            <Badge tone="outline">{TYPE_LABELS[entry.type]}</Badge>
            <span className="text-xs text-fg-secondary">
              {entry.ttlSeconds === null ? 'No expiry' : `Expires in ${formatSecondsShort(entry.ttlSeconds)}`}
            </span>
          </div>
          <EntryValue entry={entry} />
        </section>
      ))}
    </div>
  );
}
