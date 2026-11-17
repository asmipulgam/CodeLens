import { AlertTriangle, HelpCircle } from 'lucide-react';
import type { Clarification, Confirmation } from '@/api/types';
import { SourceChip } from '@/components/SourceBits';
import { Button } from '@/components/ui/button';
import { formatBytes, formatDuration, formatNumber } from '@/lib/format';

export function ClarifyCard({
  clarification,
  onChoose,
  onCancel,
}: {
  clarification: Clarification;
  onChoose: (option: { id: string; label: string }) => void;
  onCancel: () => void;
}) {
  return (
    <section
      className="space-y-3 rounded-xl border border-primary/40 bg-primary-wash/60 p-4"
      aria-label="CodeLens needs more detail"
    >
      <p className="flex items-start gap-2 font-medium">
        <HelpCircle className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        {clarification.question}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {clarification.options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onChoose(option)}
            className="rounded-lg border border-line bg-raised p-3 text-left transition-colors hover:border-primary hover:bg-surface"
          >
            <span className="block text-sm font-medium">{option.label}</span>
            {option.description && <span className="block text-xs text-fg-secondary">{option.description}</span>}
          </button>
        ))}
      </div>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel question
        </Button>
      </div>
    </section>
  );
}

export function ConfirmCard({
  confirmation,
  onConfirm,
  onCancel,
}: {
  confirmation: Confirmation;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { estimate } = confirmation;
  const facts = [
    estimate.bytesScanned !== undefined && { label: 'Data scanned', value: `~${formatBytes(estimate.bytesScanned)}` },
    estimate.seconds !== undefined && { label: 'Time', value: `~${formatDuration(estimate.seconds * 1000)}` },
    estimate.rows !== undefined && { label: 'Rows', value: `~${formatNumber(estimate.rows)}` },
    estimate.credits !== undefined && { label: 'Compute cost', value: `~${estimate.credits} credits` },
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <section className="space-y-3 rounded-xl border border-warning/50 bg-warning-wash p-4" aria-label="Large query">
      <p className="flex items-start gap-2 font-medium">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        {confirmation.message}
      </p>
      {confirmation.source && <SourceChip source={confirmation.source} />}
      {facts.length > 0 && (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {facts.map((fact) => (
            <div key={fact.label} className="rounded-lg border border-line bg-raised px-3 py-2">
              <dt className="text-xs text-fg-secondary">{fact.label}</dt>
              <dd className="text-sm font-semibold">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-xs text-fg-secondary">Tip: adding a date range or filter usually makes this much faster.</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={onConfirm}>
          Run anyway
        </Button>
      </div>
    </section>
  );
}
