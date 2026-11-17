import type { AccessRequestStatus, AuditFilters, MetricsRange } from './types';

/** Key used for the unsaved conversation shown at /ask before the backend assigns an id. */
export const NEW_CONVERSATION = 'new';

export const qk = {
  session: ['session'] as const,
  authProviders: ['auth-providers'] as const,
  preferences: ['preferences'] as const,
  sources: ['sources'] as const,
  catalog: (id: string) => ['catalog', id] as const,
  conversations: ['conversations'] as const,
  conversation: (id: string) => ['conversation', id] as const,
  saved: ['saved-questions'] as const,
  admin: {
    sources: ['admin', 'sources'] as const,
    source: (id: string) => ['admin', 'source', id] as const,
    users: ['admin', 'users'] as const,
    roles: ['admin', 'roles'] as const,
    requests: (status?: AccessRequestStatus) => ['admin', 'access-requests', status ?? 'all'] as const,
    cache: ['admin', 'cache'] as const,
    metrics: (range: MetricsRange) => ['admin', 'metrics', range] as const,
  },
  audit: (filters: AuditFilters) => ['audit', filters] as const,
};
