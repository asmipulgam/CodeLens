import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, Lock, MessageSquareText, Sparkles } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { isApiError } from '@/api/client';
import { getSourceCatalog } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import type { CatalogEntity } from '@/api/types';
import { usePermissions } from '@/auth/session';
import { HealthBadge, SOURCE_TYPE_LABELS, SourceTypeIcon } from '@/components/SourceBits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Callout, PageLoader } from '@/components/ui/misc';
import type { AskNavigationState } from '@/features/ask/AskPage';

const KIND_LABELS: Record<CatalogEntity['kind'], string> = {
  table: 'Table',
  view: 'View',
  collection: 'Collection',
  keyPattern: 'Key pattern',
};

export function CatalogSourcePage() {
  const { sourceId = '' } = useParams();
  const navigate = useNavigate();
  const { canChooseSource } = usePermissions();
  const catalog = useQuery({ queryKey: qk.catalog(sourceId), queryFn: () => getSourceCatalog(sourceId) });

  const askAbout = (prefill: string) => {
    const state: AskNavigationState = { prefill, sourceIds: canChooseSource ? [sourceId] : undefined };
    navigate('/ask', { state });
  };

  if (catalog.isPending) return <PageLoader label="Loading data source" />;
  if (catalog.isError) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6">
        <Callout tone="danger" title={isApiError(catalog.error, 'forbidden') ? "You don't have access to this data source" : "Couldn't load this data source"}>
          <Link to="/catalog" className="text-primary hover:underline">
            Back to all data sources
          </Link>
        </Callout>
      </div>
    );
  }

  const { source, entities, glossary } = catalog.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <Link to="/catalog" className="inline-flex items-center gap-1 text-sm text-fg-secondary hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden="true" /> All data sources
      </Link>

      <div className="flex flex-wrap items-start gap-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-wash">
          <SourceTypeIcon type={source.type} className="size-6" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{source.name}</h1>
            <HealthBadge status={source.status} />
          </div>
          <p className="text-sm text-fg-secondary">{SOURCE_TYPE_LABELS[source.type]}</p>
          <p className="max-w-3xl text-sm">{source.description}</p>
        </div>
        <Button onClick={() => askAbout('')}>
          <MessageSquareText aria-hidden="true" /> Ask about this data
        </Button>
      </div>

      {source.exampleQuestions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" aria-hidden="true" /> Example questions
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {source.exampleQuestions.map((question) => (
              <button
                key={question}
                type="button"
                onClick={() => askAbout(question)}
                className="rounded-full border border-line bg-raised px-3 py-1 text-left text-sm hover:border-primary hover:bg-primary-wash"
              >
                {question}
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      <section className="space-y-3" aria-labelledby="contents-title">
        <h2 id="contents-title" className="text-sm font-semibold">
          What's in it
        </h2>
        <div className="space-y-2">
          {entities.map((entity) => (
            <details key={entity.name} className="group rounded-xl border border-line bg-surface">
              <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{entity.name}</span>
                  <span className="block text-sm text-fg-secondary">{entity.description}</span>
                </span>
                <Badge tone="outline">{KIND_LABELS[entity.kind]}</Badge>
              </summary>
              <div className="overflow-x-auto border-t border-line px-4 py-3">
                <table className="w-full text-sm">
                  <caption className="sr-only">Fields in {entity.name}</caption>
                  <thead>
                    <tr className="text-left text-xs text-fg-secondary">
                      <th scope="col" className="pb-2 pr-4 font-medium">
                        Field
                      </th>
                      <th scope="col" className="pb-2 pr-4 font-medium">
                        What it means
                      </th>
                      <th scope="col" className="pb-2 font-medium">
                        Type
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {entity.fields.map((field) => (
                      <tr key={field.name} className="border-t border-line/70">
                        <td className="py-1.5 pr-4 font-mono text-xs">
                          {field.name}
                          {field.masked && (
                            <Badge className="ml-2" tone="warning">
                              <Lock aria-hidden="true" /> Hidden
                            </Badge>
                          )}
                        </td>
                        <td className="py-1.5 pr-4 text-fg-secondary">{field.description || '—'}</td>
                        <td className="py-1.5 text-xs text-fg-secondary">{field.type}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </div>
      </section>

      {glossary.length > 0 && (
        <section className="space-y-3" aria-labelledby="glossary-title">
          <h2 id="glossary-title" className="text-sm font-semibold">
            Business glossary
          </h2>
          <dl className="grid gap-3 sm:grid-cols-2">
            {glossary.map((item) => (
              <div key={item.term} className="rounded-xl border border-line bg-surface p-4">
                <dt className="font-medium">{item.term}</dt>
                <dd className="mt-1 text-sm text-fg-secondary">{item.definition}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
