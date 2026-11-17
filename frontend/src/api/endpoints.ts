import { api, apiFetch, ApiError } from './client';
import type {
  AuthProvider,
  AccessRequest,
  AccessRequestStatus,
  AdminSource,
  AdminSourceDetail,
  AdminUser,
  AuditEntry,
  AuditFilters,
  CacheOverview,
  ConnectionProbeInput,
  ConnectionTestResult,
  Conversation,
  ConversationSummary,
  DiscoveredSchema,
  FeedbackInput,
  MetricsRange,
  Page,
  Preferences,
  RoleDefinition,
  RoleInput,
  SavedQuestion,
  Session,
  SourceCatalog,
  SourceConfigInput,
  SourceSummary,
  UsageMetrics,
} from './types';

const enc = encodeURIComponent;

function toQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/* Auth */

/** Returns null when not signed in. */
export async function fetchSession(): Promise<Session | null> {
  try {
    return await api.get<Session>('/auth/session');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export const logoutRequest = () => api.post<{ redirectUrl?: string }>('/auth/logout');

export const listAuthProviders = () => api.get<AuthProvider[]>('/auth/providers');

export function loginUrl(returnTo: string, options: { reauthenticate?: boolean; provider?: string } = {}): string {
  const params = new URLSearchParams({ returnTo });
  if (options.reauthenticate) params.set('prompt', 'login');
  if (options.provider) params.set('provider', options.provider);
  return `/api/auth/login?${params.toString()}`;
}

/* Me */

export const getPreferences = () => api.get<Preferences>('/me/preferences');
export const updatePreferences = (prefs: Preferences) => api.put<Preferences>('/me/preferences', prefs);

/* Sources & catalog */

export const listSources = () => api.get<SourceSummary[]>('/sources');
export const getSourceCatalog = (id: string) => api.get<SourceCatalog>(`/sources/${enc(id)}/catalog`);
export const requestAccess = (sourceId: string, reason: string) =>
  api.post<AccessRequest>('/access-requests', { sourceId, reason });

/* Conversations */

export const listConversations = () => api.get<ConversationSummary[]>('/conversations');
export const getConversation = (id: string) => api.get<Conversation>(`/conversations/${enc(id)}`);
export const updateConversation = (id: string, patch: Partial<Pick<ConversationSummary, 'title' | 'pinned'>>) =>
  api.patch<ConversationSummary>(`/conversations/${enc(id)}`, patch);
export const deleteConversation = (id: string) => api.delete(`/conversations/${enc(id)}`);

export const listSavedQuestions = () => api.get<SavedQuestion[]>('/saved-questions');
export const saveQuestion = (question: string, sourceIds: string[]) =>
  api.post<SavedQuestion>('/saved-questions', { question, sourceIds });
export const deleteSavedQuestion = (id: string) => api.delete(`/saved-questions/${enc(id)}`);

/* Queries (streaming endpoints live in useQueryRunner via streamQueryEvents) */

export const queryPaths = {
  ask: '/queries',
  clarify: (queryId: string) => `/queries/${enc(queryId)}/clarify`,
  confirm: (queryId: string) => `/queries/${enc(queryId)}/confirm`,
  refresh: (queryId: string) => `/queries/${enc(queryId)}/refresh`,
};

export const cancelQuery = (queryId: string) => api.post<void>(`/queries/${enc(queryId)}/cancel`);
export const sendFeedback = (input: FeedbackInput) => api.post<void>('/feedback', input);

export async function exportQuery(queryId: string): Promise<{ blob: Blob; disposition: string | null }> {
  const response = await apiFetch(`/queries/${enc(queryId)}/export`, {
    method: 'POST',
    json: { format: 'csv' },
    headers: { Accept: 'text/csv' },
  });
  return { blob: await response.blob(), disposition: response.headers.get('Content-Disposition') };
}

/* Admin: sources */

export const adminListSources = () => api.get<AdminSource[]>('/admin/sources');
export const adminGetSource = (id: string) => api.get<AdminSourceDetail>(`/admin/sources/${enc(id)}`);
export const adminCreateSource = (input: SourceConfigInput) => api.post<AdminSourceDetail>('/admin/sources', input);
export const adminUpdateSource = (id: string, input: SourceConfigInput) =>
  api.put<AdminSourceDetail>(`/admin/sources/${enc(id)}`, input);
export const adminSetSourceEnabled = (id: string, enabled: boolean) =>
  api.patch<AdminSource>(`/admin/sources/${enc(id)}`, { enabled });
export const adminDeleteSource = (id: string) => api.delete(`/admin/sources/${enc(id)}`);
export const adminCheckSource = (id: string) => api.post<AdminSource>(`/admin/sources/${enc(id)}/check`);
export const adminTestConnection = (input: ConnectionProbeInput) =>
  api.post<ConnectionTestResult>('/admin/sources/test', input);
export const adminDiscoverSchema = (input: ConnectionProbeInput) =>
  api.post<DiscoveredSchema>('/admin/sources/discover', input);

/* Admin: users, roles, access requests */

export const adminListUsers = () => api.get<AdminUser[]>('/admin/users');
export const adminSetUserRoles = (id: string, roleIds: string[]) =>
  api.put<AdminUser>(`/admin/users/${enc(id)}/roles`, { roleIds });
export const adminListRoles = () => api.get<RoleDefinition[]>('/admin/roles');
export const adminCreateRole = (input: RoleInput) => api.post<RoleDefinition>('/admin/roles', input);
export const adminUpdateRole = (id: string, input: RoleInput) =>
  api.put<RoleDefinition>(`/admin/roles/${enc(id)}`, input);
export const adminListAccessRequests = (status?: AccessRequestStatus) =>
  api.get<AccessRequest[]>(`/admin/access-requests${toQueryString({ status })}`);
export const adminDecideAccessRequest = (id: string, decision: 'approve' | 'reject', note: string) =>
  api.post<AccessRequest>(`/admin/access-requests/${enc(id)}/decision`, { decision, note });

/* Admin: cache & metrics */

export const adminGetCache = () => api.get<CacheOverview>('/admin/cache');
export const adminSetCacheTtl = (sourceId: string, ttlSeconds: number) =>
  api.patch<CacheOverview>(`/admin/cache/sources/${enc(sourceId)}`, { ttlSeconds });
export const adminClearCache = (sourceId?: string) => api.post<CacheOverview>('/admin/cache/clear', { sourceId });
export const adminGetMetrics = (range: MetricsRange) => api.get<UsageMetrics>(`/admin/metrics?range=${range}`);

/* Audit */

export function auditQueryString(filters: AuditFilters): string {
  return toQueryString({
    q: filters.q,
    user: filters.user,
    sourceId: filters.sourceId,
    action: filters.action,
    outcome: filters.outcome,
    range: filters.range,
    queryId: filters.queryId,
    page: filters.page,
    pageSize: filters.pageSize,
  });
}

export const listAudit = (filters: AuditFilters) => api.get<Page<AuditEntry>>(`/audit${auditQueryString(filters)}`);

export async function exportAudit(filters: AuditFilters): Promise<{ blob: Blob; disposition: string | null }> {
  const response = await apiFetch('/audit/export', {
    method: 'POST',
    json: filters,
    headers: { Accept: 'text/csv' },
  });
  return { blob: await response.blob(), disposition: response.headers.get('Content-Disposition') };
}
