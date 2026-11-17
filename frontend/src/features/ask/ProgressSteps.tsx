import { Check, Loader2 } from 'lucide-react';
import type { QueryStage } from '@/api/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

export const STAGES: { stage: QueryStage; label: string }[] = [
  { stage: 'understanding', label: 'Understanding your question' },
  { stage: 'routing', label: 'Choosing the right data source' },
  { stage: 'building', label: 'Building the query' },
  { stage: 'running', label: 'Running the query' },
  { stage: 'summarising', label: 'Summarising the results' },
];

export function stageLabel(stage: QueryStage | undefined) {
  return STAGES.find((item) => item.stage === stage)?.label ?? 'Working on it';
}

export function ProgressSteps({ stage, onCancel }: { stage?: QueryStage; onCancel: () => void }) {
  const current = Math.max(0, STAGES.findIndex((item) => item.stage === stage));
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="sr-only" aria-live="polite">
        {stageLabel(stage)}
      </p>
      <ol className="space-y-2" aria-label="Progress">
        {STAGES.map((item, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li
              key={item.stage}
              className={cn('flex items-center gap-2.5 text-sm', done || active ? 'text-fg' : 'text-fg-muted')}
              aria-current={active ? 'step' : undefined}
            >
              <span
                className={cn(
                  'grid size-5 place-items-center rounded-full border',
                  done && 'border-success bg-success text-white',
                  active && 'border-primary text-primary',
                  !done && !active && 'border-line',
                )}
                aria-hidden="true"
              >
                {done ? (
                  <Check className="size-3" />
                ) : active ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : null}
              </span>
              {item.label}
            </li>
          );
        })}
      </ol>
      <div className="mt-3 flex justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
