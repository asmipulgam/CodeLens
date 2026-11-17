import { ArrowRight, BookOpen, Sparkles } from 'lucide-react';
import { Link } from 'react-router';
import type { SourceSummary } from '@/api/types';
import { SourceTypeIcon } from '@/components/SourceBits';
import { Logo } from '@/app/Logo';
import { firstName } from '@/lib/format';

export function WelcomeScreen({
  name,
  sources,
  onAsk,
}: {
  name: string;
  sources: SourceSummary[];
  onAsk: (question: string, sourceIds: string[]) => void;
}) {
  const granted = sources.filter((source) => source.access === 'granted' && source.status !== 'offline');
  const suggestions = granted
    .flatMap((source) => source.exampleQuestions.slice(0, 2).map((question) => ({ question, source })))
    .slice(0, 6);

  return (
    <div className="flex flex-col items-center gap-8 py-10 text-center">
      <div className="flex flex-col items-center gap-3">
        <Logo size="lg" />
        <h1 className="text-2xl font-semibold tracking-tight">Hi {firstName(name)}, what would you like to know?</h1>
        <p className="max-w-lg text-sm text-fg-secondary">
          Ask about your company's data in plain English. CodeLens finds the right database, runs a safe read-only
          query and explains the answer.
        </p>
      </div>

      {suggestions.length > 0 && (
        <section className="w-full max-w-3xl space-y-3 text-left" aria-labelledby="suggestions-title">
          <h2 id="suggestions-title" className="flex items-center gap-1.5 text-sm font-medium text-fg-secondary">
            <Sparkles className="size-4" aria-hidden="true" /> Try one of these
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {suggestions.map(({ question, source }) => (
              <button
                key={`${source.id}-${question}`}
                type="button"
                onClick={() => onAsk(question, [])}
                className="group flex items-start gap-3 rounded-xl border border-line bg-surface p-3 text-left transition-colors hover:border-primary hover:bg-primary-wash"
              >
                <SourceTypeIcon type={source.type} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-fg">{question}</span>
                  <span className="block text-xs text-fg-secondary">{source.name}</span>
                </span>
                <ArrowRight
                  className="mt-0.5 size-4 text-fg-muted transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
        </section>
      )}

      <Link to="/catalog" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
        <BookOpen className="size-4" aria-hidden="true" /> See all the data you can ask about
      </Link>
    </div>
  );
}
