import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bookmark,
  ChevronRight,
  ClipboardCopy,
  Copy,
  Download,
  Lock,
  RefreshCw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { exportQuery, saveQuestion, sendFeedback } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import type { Answer, AssistantMessage, GeneratedQuery, ResultSet, SingleResult } from '@/api/types';
import { usePermissions } from '@/auth/session';
import { RelativeTime } from '@/components/RelativeTime';
import { SOURCE_TYPE_LABELS, SourceChip } from '@/components/SourceBits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { usePreferences, useUpdatePreferences } from '@/features/shared/hooks';
import { documentsToTable } from '@/features/results/flatten';
import { ResultView } from '@/features/results/ResultView';
import { toTsv } from '@/lib/csv';
import { filenameFromDisposition, saveBlob } from '@/lib/download';
import { formatDuration, formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';
import { FeedbackDialog } from './FeedbackDialog';
import { stageLabel } from './ProgressSteps';

const REFRESH_COOLDOWN_MS = 30_000;

function hasMaskedData(result: ResultSet): boolean {
  if (result.kind === 'multi') return result.parts.some((part) => hasMaskedData(part.result));
  if (result.kind === 'table') return result.columns.some((column) => column.masked);
  if (result.kind === 'documents') return result.maskedPaths.length > 0;
  return result.entries.some((entry) => entry.masked);
}

function tableForCopy(result: ResultSet): { header: string[]; rows: unknown[][] } | null {
  const single: SingleResult | undefined = result.kind === 'multi' ? undefined : result;
  if (!single) return null;
  if (single.kind === 'table') {
    return {
      header: single.columns.map((column) => column.label),
      rows: single.rows.map((row) =>
        single.columns.map((column) => (column.masked && row[column.key] === null ? '[hidden]' : row[column.key])),
      ),
    };
  }
  if (single.kind === 'documents') {
    const table = documentsToTable(single.documents, single.maskedPaths);
    return {
      header: table.columns.map((column) => column.label),
      rows: table.rows.map((row) =>
        table.columns.map((column) => (column.masked && row[column.key] === null ? '[hidden]' : row[column.key])),
      ),
    };
  }
  return null;
}

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Couldn't copy — your browser blocked clipboard access.");
  }
}

function FreshnessBadge({ answer }: { answer: Answer }) {
  const { freshness } = answer;
  if (freshness.status === 'cached' && freshness.cachedAt) {
    return (
      <Tip content="Reused from a recent identical question by someone with the same access, to answer faster. Refresh for live data.">
        <span tabIndex={0} className="inline-flex">
          <Badge tone="neutral">
            <Zap aria-hidden="true" /> Cached · <RelativeTime iso={freshness.cachedAt} mode="age" />
          </Badge>
        </span>
      </Tip>
    );
  }
  return (
    <Badge tone="success">
      <span className="size-1.5 rounded-full" style={{ background: 'var(--status-good)' }} aria-hidden="true" />
      Live · {formatDuration(freshness.durationMs)}
    </Badge>
  );
}

function GeneratedQueries({ queries }: { queries: GeneratedQuery[] }) {
  return (
    <div className="space-y-3">
      {queries.map((query, index) => (
        <div key={`${query.source.id}-${index}`} className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-xs text-fg-secondary">
            <span>
              {query.language === 'sql' ? 'SQL' : query.language === 'mongodb' ? 'MongoDB pipeline' : 'Redis commands'} ·{' '}
              {query.source.name} ({SOURCE_TYPE_LABELS[query.source.type]})
            </span>
            <Button variant="ghost" size="sm" onClick={() => void copyText(query.text, 'Query')}>
              <Copy aria-hidden="true" /> Copy
            </Button>
          </div>
          <pre className="max-h-64 overflow-auto rounded-lg border border-line bg-wash p-3 font-mono text-xs leading-relaxed">
            <code>{query.text}</code>
          </pre>
        </div>
      ))}
      <p className="text-xs text-fg-secondary">Queries run with a read-only account. CodeLens never changes data.</p>
    </div>
  );
}

interface AnswerCardProps {
  message: AssistantMessage & { answer: Answer };
  onRefresh: () => void;
  onCancelRefresh: () => void;
  onFollowUp: (question: string) => void;
}

export function AnswerCard({ message, onRefresh, onCancelRefresh, onFollowUp }: AnswerCardProps) {
  const { answer } = message;
  const permissions = usePermissions();
  const { data: prefs } = usePreferences();
  const qc = useQueryClient();
  const [rating, setRating] = useState<'up' | 'down' | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const id = window.setTimeout(() => forceTick((n) => n + 1), cooldownUntil - Date.now());
    return () => window.clearTimeout(id);
  }, [cooldownUntil]);

  const updatePrefs = useUpdatePreferences();
  // The server only includes generated queries for roles allowed to see them.
  const canSeeQuery = Boolean(answer.generatedQueries?.length);
  const showQuery = canSeeQuery && prefs?.showGeneratedQuery === true;
  const setShowQuery = (checked: boolean) => {
    if (prefs) updatePrefs.mutate({ ...prefs, showGeneratedQuery: checked });
  };
  const copyable = permissions.canExport ? tableForCopy(answer.result) : null;
  const masked = hasMaskedData(answer.result);
  const coolingDown = cooldownUntil > Date.now();

  const exportMutation = useMutation({
    mutationFn: () => exportQuery(answer.queryId),
    onSuccess: ({ blob, disposition }) => {
      saveBlob(blob, filenameFromDisposition(disposition, 'codelens-export.csv'));
      toast.success('Export downloaded', { description: 'This export was recorded in the audit log.' });
      setExportOpen(false);
    },
    onError: (error) => toast.error("Couldn't export", { description: errorMessage(error) }),
  });

  const saveMutation = useMutation({
    mutationFn: () => saveQuestion(answer.question, answer.sources.map((source) => source.id)),
    onSuccess: () => {
      toast.success('Question saved', { description: 'Find it under “Saved” in the sidebar.' });
      void qc.invalidateQueries({ queryKey: qk.saved });
    },
    onError: (error) => toast.error("Couldn't save", { description: errorMessage(error) }),
  });

  const thumbsUp = useMutation({
    mutationFn: () => sendFeedback({ queryId: answer.queryId, rating: 'up' }),
    onSuccess: () => setRating('up'),
    onError: (error) => toast.error("Couldn't send feedback", { description: errorMessage(error) }),
  });

  const refresh = () => {
    setCooldownUntil(Date.now() + REFRESH_COOLDOWN_MS);
    onRefresh();
  };

  return (
    <article className="space-y-4 rounded-xl border border-line bg-surface p-4 shadow-sm sm:p-5" aria-label="Answer">
      <header className="flex flex-wrap items-center gap-2">
        {answer.sources.map((source) => (
          <SourceChip key={source.id} source={source} />
        ))}
        <span className="ml-auto flex items-center gap-1">
          <FreshnessBadge answer={answer} />
          <Tip content={coolingDown ? 'You just refreshed — try again in a few seconds' : 'Run again with live data'}>
            <span tabIndex={coolingDown ? 0 : -1}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh with live data"
                disabled={coolingDown || message.refreshing}
                onClick={refresh}
              >
                <RefreshCw className={cn(message.refreshing && 'animate-spin')} />
              </Button>
            </span>
          </Tip>
        </span>
      </header>

      {message.refreshing && (
        <div className="flex items-center justify-between rounded-lg bg-primary-wash px-3 py-2 text-sm" aria-live="polite">
          <span>Getting live data — {stageLabel(message.stage).toLowerCase()}…</span>
          <Button variant="ghost" size="sm" onClick={onCancelRefresh}>
            Cancel
          </Button>
        </div>
      )}

      <p className="text-base leading-relaxed text-fg">{answer.summary}</p>

      {answer.highlights.length > 0 && (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {answer.highlights.slice(0, 4).map((item) => (
            <div key={item.label} className="rounded-lg border border-line bg-raised px-3 py-2">
              <dt className="text-xs text-fg-secondary">{item.label}</dt>
              <dd className="text-lg font-semibold">{item.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <ResultView result={answer.result} chart={answer.chart} caption={`Results for: ${answer.question}`} />

      {masked && (
        <p className="flex items-center gap-1.5 text-xs text-fg-secondary">
          <Lock className="size-3" aria-hidden="true" /> Some values are hidden by your company's data policy.
        </p>
      )}

      {canSeeQuery && (
        <section className="space-y-2" aria-label="Generated query">
          <div className="flex items-center gap-2">
            <Switch
              id={`show-query-${answer.queryId}`}
              checked={showQuery}
              disabled={!prefs}
              onCheckedChange={setShowQuery}
            />
            <label htmlFor={`show-query-${answer.queryId}`} className="cursor-pointer text-sm font-medium">
              Show query
            </label>
            <span className="text-xs text-fg-secondary">Applies to all your answers</span>
          </div>
          {showQuery && answer.generatedQueries && (
            <div className="rounded-lg border border-line bg-raised p-3">
              <GeneratedQueries queries={answer.generatedQueries} />
            </div>
          )}
        </section>
      )}

      <details className="group rounded-lg border border-line bg-raised">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />
          How I got this
        </summary>
        <div className="space-y-3 border-t border-line px-3 py-3 text-sm text-fg-secondary">
          <p>{answer.explanation}</p>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-1 border-t border-line pt-3">
        <Button variant="ghost" size="sm" onClick={() => void copyText(answer.summary, 'Answer')}>
          <Copy aria-hidden="true" /> Copy answer
        </Button>
        {copyable && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void copyText(toTsv(copyable.header, copyable.rows), 'Table')}
          >
            <ClipboardCopy aria-hidden="true" /> Copy table
          </Button>
        )}
        {permissions.canExport && (
          <Button variant="ghost" size="sm" onClick={() => setExportOpen(true)}>
            <Download aria-hidden="true" /> Export CSV
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          <Bookmark aria-hidden="true" /> Save
        </Button>
        <span className="ml-auto flex items-center gap-1">
          <span className="mr-1 hidden text-xs text-fg-secondary sm:inline">Was this right?</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Yes, this answer was helpful"
            aria-pressed={rating === 'up'}
            disabled={rating !== null || thumbsUp.isPending}
            onClick={() => thumbsUp.mutate()}
            className={cn(rating === 'up' && 'text-success')}
          >
            <ThumbsUp />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="No, report a problem with this answer"
            aria-pressed={rating === 'down'}
            disabled={rating !== null}
            onClick={() => setFeedbackOpen(true)}
            className={cn(rating === 'down' && 'text-danger')}
          >
            <ThumbsDown />
          </Button>
        </span>
      </div>

      {answer.followUps.length > 0 && (
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-fg-secondary">
            <Sparkles className="size-3.5" aria-hidden="true" /> You could also ask
          </p>
          <div className="flex flex-wrap gap-2">
            {answer.followUps.map((question) => (
              <button
                key={question}
                type="button"
                onClick={() => onFollowUp(question)}
                className="rounded-full border border-line bg-raised px-3 py-1 text-left text-sm hover:border-primary hover:bg-primary-wash"
              >
                {question}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-fg-muted">
        AI-generated from company data. Double-check important figures before sharing them with clients.
      </p>

      <FeedbackDialog
        queryId={answer.queryId}
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        onSent={() => setRating('down')}
      />
      <ConfirmDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        title="Export to CSV?"
        description={
          <>
            Up to {formatNumber(permissions.exportRowLimit)} rows will be downloaded. Exports are recorded in the audit
            log and the file is labelled with your name. Store it securely and don't share it outside the company.
          </>
        }
        confirmLabel="Export"
        busy={exportMutation.isPending}
        onConfirm={() => exportMutation.mutate()}
      />
    </article>
  );
}
