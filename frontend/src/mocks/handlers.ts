/**
 * Mock implementation of the CodeLens API for local development and demos.
 * It mirrors the security behaviour the real backend must have (session check, CSRF check,
 * permission checks, per-role data access, masking, audit logging) so the UI can be tested
 * against it. Never deployed: excluded from production builds.
 */
import { http, HttpResponse } from 'msw';
import type {
  AccessRequest,
  AdminSource,
  AdminSourceDetail,
  Answer,
  AssistantMessage,
  AuditEntry,
  AuditFilters,
  CacheOverview,
  Conversation,
  ConversationSummary,
  DiscoveredSchema,
  EntityKind,
  Permissions,
  QueryEvent,
  QueryStage,
  Role,
  RoleDefinition,
  SessionUser,
  Session,
  SingleResult,
  SourceSummary,
  SourceType,
  UsageMetrics,
} from '@/api/types';
import { documentsToTable } from '@/features/results/flatten';
import { toCsv } from '@/lib/csv';
import * as db from './data';
import { plan, sourceRef, type AnswerDraft } from './engine';

/* ───────────────────────── helpers ───────────────────────── */

const SESSION_KEY = 'codelens.mock.role';
const IDLE_TIMEOUT_SECONDS = 15 * 60;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function json(data: unknown, status = 200) {
  return new HttpResponse(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function noContent() {
  return new HttpResponse(null, { status: 204 });
}

function fail(status: number, code: string, message: string) {
  return json({ code, message }, status);
}

async function body<T>(request: Request): Promise<Partial<T>> {
  try {
    return (await request.json()) as Partial<T>;
  } catch {
    return {};
  }
}

function csvResponse(csv: string, filename: string) {
  return new HttpResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/* ───────────────────────── session ───────────────────────── */

interface MockSession {
  role: Role;
  csrfToken: string;
  expiresAt: string;
}

function createSession(role: Role): MockSession {
  return { role, csrfToken: crypto.randomUUID(), expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString() };
}

function restoreSession(): MockSession | null {
  try {
    // Demo only: remembers which demo role was picked so a page reload keeps you signed in.
    const role = window.sessionStorage.getItem(SESSION_KEY);
    if (role && role in db.DEMO_USERS) return createSession(role as Role);
  } catch {
    // ignore
  }
  return null;
}

let session: MockSession | null = restoreSession();

function currentUser(): SessionUser {
  const role = session?.role ?? 'business';
  const base = db.DEMO_USERS[role];
  const definition = db.roles.find((item) => item.id === role);
  return { ...base, permissions: definition?.permissions ?? base.permissions };
}

function sessionPayload(): Session {
  if (!session) throw new Error('No session');
  return {
    user: currentUser(),
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
    idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    // The demo has no identity provider to re-authenticate with, so step-up lasts the whole session.
    recentAuthUntil: session.expiresAt,
  };
}

type Guard = { ok: true; user: SessionUser } | { ok: false; response: Response };

/** Every endpoint: signed in? CSRF token valid for writes? Permission held? */
function guard(request: Request, permission?: keyof Permissions): Guard {
  if (!session) return { ok: false, response: fail(401, 'unauthorized', 'Please sign in again.') };
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && request.headers.get('X-CSRF-Token') !== session.csrfToken) {
    return { ok: false, response: fail(403, 'csrf_failed', 'Security check failed. Refresh the page and try again.') };
  }
  const user = currentUser();
  if (permission && !user.permissions[permission]) {
    return { ok: false, response: fail(403, 'forbidden', "You don't have permission to do that.") };
  }
  return { ok: true, user };
}

function allowedSourceIds(user: SessionUser): Set<string> {
  const ids = new Set<string>();
  for (const role of user.roles) db.roles.find((item) => item.id === role)?.sourceIds.forEach((id) => ids.add(id));
  db.userGrants.get(user.id)?.forEach((id) => ids.add(id));
  for (const source of db.sources) if (!source.enabled) ids.delete(source.id);
  return ids;
}

/* ───────────────────────── audit ───────────────────────── */

function record(user: { id: string; name: string; email: string }, entry: Omit<AuditEntry, 'id' | 'timestamp' | 'user' | 'ipAddress'> & { timestamp?: string }) {
  db.audit.unshift({
    id: db.nextId('au'),
    ipAddress: '10.20.4.17',
    ...entry,
    timestamp: entry.timestamp ?? new Date().toISOString(),
    user: { id: user.id, name: user.name, email: user.email },
  });
}

function rowsOf(result: Answer['result']): number {
  if (result.kind === 'multi') return result.parts.reduce((sum, part) => sum + rowsOf(part.result), 0);
  if (result.kind === 'table') return result.rows.length;
  if (result.kind === 'documents') return result.documents.length;
  return result.entries.length;
}

/* ───────────────────────── queries & cache ───────────────────────── */

interface QueryRecord {
  id: string;
  userId: string;
  question: string;
  sourceIds: string[];
  conversationId: string;
  assistantMessageId: string;
  clarificationOptionId?: string;
  clarificationOptions?: { id: string; label: string }[];
  confirmed?: boolean;
  cancelled?: boolean;
  answer?: Answer;
}

const queries = new Map<string, QueryRecord>();

interface CacheEntry {
  draft: AnswerDraft;
  cachedAt: string;
  sourceIds: string[];
  sizeBytes: number;
}

const answerCache = new Map<string, CacheEntry>();
const cacheStats = new Map<string, { hits: number; misses: number; baseEntries: number }>(
  db.sources.map((source, index) => [source.id, { hits: 180 + index * 47, misses: 120 + index * 31, baseEntries: 40 + index * 12 }]),
);

function cacheKey(user: SessionUser, recordItem: QueryRecord) {
  const scope = [...allowedSourceIds(user)].sort().join(',');
  const question = recordItem.question.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  return [user.roles.join('+'), scope, question, recordItem.sourceIds.join(','), recordItem.clarificationOptionId ?? ''].join('|');
}

function ttlFor(sourceIds: string[]) {
  const ttls = db.sources.filter((source) => sourceIds.includes(source.id)).map((source) => source.cacheTtlSeconds);
  return ttls.length ? Math.min(...ttls) : 0;
}

function stripForUser(answer: Answer, user: SessionUser): Answer {
  return user.permissions.canViewQuery ? answer : { ...answer, generatedQueries: undefined };
}

function storeAssistant(recordItem: QueryRecord, patch: Partial<AssistantMessage>) {
  const conversation = db.conversations.get(recordItem.conversationId);
  if (!conversation) return;
  conversation.messages = conversation.messages.map((message) =>
    message.id === recordItem.assistantMessageId && message.role === 'assistant' ? { ...message, ...patch } : message,
  );
  conversation.updatedAt = new Date().toISOString();
}

type Emit = (event: QueryEvent) => void;

function sse(run: (emit: Emit) => Promise<void>) {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: Emit = (event) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      try {
        await run(emit);
      } catch {
        emit({ type: 'error', error: { code: 'internal', message: 'The demo backend hit an unexpected error.' } });
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new HttpResponse(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
  });
}

async function runQuery(recordItem: QueryRecord, user: SessionUser, emit: Emit, options: { refresh?: boolean; resume?: boolean } = {}) {
  const startedAt = Date.now();
  emit({ type: 'started', queryId: recordItem.id, conversationId: recordItem.conversationId });
  const progress = async (stage: QueryStage, ms: number) => {
    emit({ type: 'progress', stage });
    storeAssistant(recordItem, { stage });
    await sleep(ms);
  };

  if (!options.resume) await progress('understanding', 500);
  if (recordItem.cancelled) return;

  const result = plan({
    question: recordItem.question,
    allowedSourceIds: allowedSourceIds(user),
    selectedSourceIds: recordItem.sourceIds,
    clarificationOptionId: recordItem.clarificationOptionId,
    confirmed: recordItem.confirmed,
  });

  if (!options.resume) await progress('routing', 450);
  if (recordItem.cancelled) return;

  if (result.kind === 'clarify') {
    recordItem.clarificationOptions = result.clarification.options;
    emit({ type: 'clarification', clarification: result.clarification });
    storeAssistant(recordItem, { status: 'needs_clarification', clarification: result.clarification, stage: undefined });
    return;
  }
  if (result.kind === 'confirm') {
    emit({ type: 'confirmation', confirmation: result.confirmation });
    storeAssistant(recordItem, { status: 'needs_confirmation', confirmation: result.confirmation, stage: undefined });
    return;
  }
  if (result.kind === 'error') {
    emit({ type: 'error', error: result.error });
    storeAssistant(recordItem, { status: 'error', error: result.error, stage: undefined });
    record(user, {
      action: 'query',
      outcome: result.error.code === 'forbidden' || result.error.code === 'write_blocked' ? 'denied' : 'error',
      queryId: recordItem.id,
      question: recordItem.question,
      sources: result.sources,
      durationMs: Date.now() - startedAt,
      details: result.error.message,
    });
    return;
  }

  const sourceIds = result.sources.map((source) => source.id);
  const key = cacheKey(user, recordItem);
  const ttl = ttlFor(sourceIds);
  const hit = options.refresh || ttl === 0 ? undefined : answerCache.get(key);
  const fresh = hit && Date.now() - Date.parse(hit.cachedAt) < ttl * 1000 ? hit : undefined;
  for (const id of sourceIds) {
    const stats = cacheStats.get(id);
    if (stats) {
      if (fresh) stats.hits += 1;
      else stats.misses += 1;
    }
  }

  if (!fresh) {
    await progress('building', 550);
    if (recordItem.cancelled) return;
    const slow = result.sources.some((source) => source.type === 'snowflake');
    await progress('running', slow ? 1600 : 800);
    if (recordItem.cancelled) return;
  }
  await progress('summarising', fresh ? 250 : 450);
  if (recordItem.cancelled) return;

  const draft = fresh?.draft ?? result.draft;
  const answer: Answer = stripForUser(
    {
      ...draft,
      queryId: recordItem.id,
      question: recordItem.question,
      rowLimit: 500,
      freshness: fresh
        ? { status: 'cached', cachedAt: fresh.cachedAt, durationMs: Date.now() - startedAt }
        : { status: 'live', durationMs: Date.now() - startedAt },
    },
    user,
  );

  if (!fresh && ttl > 0) {
    answerCache.set(key, {
      draft,
      cachedAt: new Date().toISOString(),
      sourceIds,
      sizeBytes: JSON.stringify(draft).length,
    });
  }

  recordItem.answer = answer;
  emit({ type: 'result', answer });
  storeAssistant(recordItem, { status: 'done', answer, stage: undefined, queryId: recordItem.id });
  record(user, {
    action: options.refresh ? 'refresh' : 'query',
    outcome: 'success',
    queryId: recordItem.id,
    question: recordItem.question,
    sources: answer.sources,
    generatedQueries: draft.generatedQueries,
    rowsReturned: rowsOf(answer.result),
    cached: Boolean(fresh),
    durationMs: answer.freshness.durationMs,
  });
}

function ownedQuery(id: string, user: SessionUser) {
  const recordItem = queries.get(id);
  return recordItem && recordItem.userId === user.id ? recordItem : undefined;
}

/* ───────────────────────── seeding ───────────────────────── */

function seed() {
  const conversationsFor: { role: Role; items: { question: string; minutesAgo: number; pinned?: boolean }[] }[] = [
    {
      role: 'business',
      items: [
        { question: 'Which customers renew in the next 30 days?', minutesAgo: 60 * 3, pinned: true },
        { question: 'What were total sales by region last month?', minutesAgo: 60 * 26 },
        { question: 'Which orders are delayed in shipping?', minutesAgo: 60 * 24 * 4 },
        { question: 'How many people are using the app right now?', minutesAgo: 60 * 24 * 12 },
      ],
    },
    {
      role: 'analyst',
      items: [
        { question: 'Show monthly revenue for this year compared with last year', minutesAgo: 90, pinned: true },
        { question: 'How many transactions did we process each year?', minutesAgo: 60 * 30 },
        { question: 'What are our top products by revenue?', minutesAgo: 60 * 24 * 9 },
      ],
    },
    {
      role: 'admin',
      items: [
        { question: 'What is our headcount by department?', minutesAgo: 60 * 5 },
        { question: 'Which feature flags are turned on?', minutesAgo: 60 * 24 * 2 },
      ],
    },
  ];

  for (const { role, items } of conversationsFor) {
    const user = { ...db.DEMO_USERS[role] };
    for (const item of items) {
      const createdAt = db.isoMinutesAgo(item.minutesAgo);
      const queryId = db.nextId('q');
      const result = plan({ question: item.question, allowedSourceIds: allowedSourceIds(user), selectedSourceIds: [], confirmed: true });
      const assistant: AssistantMessage = { id: db.nextId('m'), role: 'assistant', createdAt, queryId, status: 'error' };
      if (result.kind === 'answer') {
        assistant.status = 'done';
        assistant.answer = {
          ...result.draft,
          queryId,
          question: item.question,
          rowLimit: 500,
          freshness: { status: 'live', durationMs: 1800 + item.minutesAgo % 900 },
        };
      } else if (result.kind === 'error') {
        assistant.error = result.error;
      }
      const conversation: Conversation & { ownerId: string } = {
        id: db.nextId('c'),
        ownerId: user.id,
        title: item.question,
        pinned: Boolean(item.pinned),
        updatedAt: createdAt,
        messages: [{ id: db.nextId('m'), role: 'user', content: item.question, createdAt }, assistant],
      };
      db.conversations.set(conversation.id, conversation);
      queries.set(queryId, {
        id: queryId,
        userId: user.id,
        question: item.question,
        sourceIds: [],
        conversationId: conversation.id,
        assistantMessageId: assistant.id,
        answer: assistant.answer,
      });
    }
  }

  // A month of audit history.
  let state = 42;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const actors = db.users.filter((user) => user.status === 'active');
  const questions = db.sources.flatMap((source) => source.exampleQuestions.map((question) => ({ question, source })));
  for (let index = 0; index < 140; index += 1) {
    const actor = actors[Math.floor(random() * actors.length)];
    const pickQ = questions[Math.floor(random() * questions.length)];
    const minutesAgo = Math.floor(random() * 60 * 24 * 30) + 30;
    const roll = random();
    const offline = pickQ.source.status === 'offline';
    const denied = pickQ.source.id === 'hr' && !actor.roleIds.includes('admin');
    const action = roll > 0.93 ? 'export' : roll > 0.88 ? 'login' : 'query';
    db.audit.push({
      id: `au-seed-${index}`,
      timestamp: db.isoMinutesAgo(minutesAgo),
      user: { id: actor.id, name: actor.name, email: actor.email },
      action,
      outcome: action !== 'query' ? 'success' : denied ? 'denied' : offline ? 'error' : roll < 0.04 ? 'cancelled' : 'success',
      queryId: action === 'login' ? undefined : `q-seed-${index}`,
      question: action === 'login' ? undefined : pickQ.question,
      sources: action === 'login' ? [] : [sourceRef(pickQ.source.id)],
      rowsReturned: action === 'login' || denied || offline ? undefined : Math.floor(random() * 480) + 3,
      cached: action === 'query' && !denied && !offline ? random() > 0.55 : undefined,
      durationMs: action === 'login' ? undefined : Math.floor(random() * 5000) + 300,
      ipAddress: `10.20.${Math.floor(random() * 30)}.${Math.floor(random() * 250)}`,
      details: denied ? 'Role has no access to HR System' : offline ? 'Billing (Legacy) is offline' : undefined,
    });
  }
  db.audit.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

seed();

/* ───────────────────────── metrics ───────────────────────── */

function buildMetrics(range: '7d' | '30d'): UsageMetrics {
  const days = range === '7d' ? 7 : 30;
  const daily = Array.from({ length: days }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (days - 1 - index));
    const weekday = date.getDay();
    const weekend = weekday === 0 || weekday === 6;
    const base = weekend ? 60 : 210 + ((index * 37) % 70);
    const cached = Math.round(base * (0.38 + ((index * 13) % 17) / 100));
    return {
      date: date.toISOString().slice(0, 10),
      live: base - cached,
      cached,
      p50LatencyMs: 1400 + ((index * 97) % 600),
      p95LatencyMs: 4200 + ((index * 389) % 2600),
      failed: 2 + ((index * 7) % 6),
    };
  });
  const questions = daily.reduce((sum, day) => sum + day.live + day.cached, 0);
  const cached = daily.reduce((sum, day) => sum + day.cached, 0);
  const totals = {
    questions,
    activeUsers: range === '7d' ? 38 : 61,
    cacheHitRate: cached / questions,
    p95LatencyMs: Math.round(daily.reduce((sum, day) => sum + day.p95LatencyMs, 0) / days),
    failedQueries: daily.reduce((sum, day) => sum + day.failed, 0),
  };
  const shares: [string, number][] = [
    ['sales-db', 0.34],
    ['crm', 0.22],
    ['order-events', 0.19],
    ['warehouse', 0.12],
    ['live-cache', 0.08],
    ['billing-legacy', 0.03],
    ['hr', 0.02],
  ];
  return {
    range,
    totals,
    previous: {
      questions: Math.round(questions * 0.86),
      activeUsers: Math.round(totals.activeUsers * 0.9),
      cacheHitRate: totals.cacheHitRate - 0.04,
      p95LatencyMs: Math.round(totals.p95LatencyMs * 1.12),
      failedQueries: Math.round(totals.failedQueries * 0.8),
    },
    daily,
    topSources: shares.map(([id, share]) => ({ source: sourceRef(id), questions: Math.round(questions * share) })),
    negativeFeedback: db.feedback,
  };
}

/* ───────────────────────── admin helpers ───────────────────────── */

function toAdminSource(source: AdminSourceDetail): AdminSource {
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    description: source.description,
    status: source.status,
    lastCheckedAt: source.lastCheckedAt,
    owner: source.owner,
    enabled: source.enabled,
    exposedCount: source.exposed.length,
    cacheTtlSeconds: source.cacheTtlSeconds,
  };
}

function recomputeMemberCounts() {
  for (const role of db.roles) role.memberCount = db.users.filter((user) => user.roleIds.includes(role.id)).length;
}

function cacheOverview(): CacheOverview {
  const rows = db.sources.map((source) => {
    const stats = cacheStats.get(source.id) ?? { hits: 0, misses: 0, baseEntries: 0 };
    const live = [...answerCache.values()].filter((entry) => entry.sourceIds.includes(source.id));
    const entries = stats.baseEntries + live.length;
    return {
      source: sourceRef(source.id),
      ttlSeconds: source.cacheTtlSeconds,
      hitRate: stats.hits / Math.max(1, stats.hits + stats.misses),
      entries,
      sizeBytes: entries * 14_200 + live.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    };
  });
  const hits = [...cacheStats.values()].reduce((sum, stats) => sum + stats.hits, 0);
  const total = [...cacheStats.values()].reduce((sum, stats) => sum + stats.hits + stats.misses, 0);
  return {
    hitRate: hits / Math.max(1, total),
    entries: rows.reduce((sum, row) => sum + row.entries, 0),
    sizeBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
    sources: rows,
  };
}

const DISCOVERY: Record<SourceType, { namespace: string; entities: { name: string; kind: EntityKind; fields: string[] }[] }> = {
  postgresql: {
    namespace: 'public',
    entities: [
      { name: 'orders', kind: 'table', fields: ['order_id', 'order_date', 'region_id', 'customer_id', 'total_amount', 'status'] },
      { name: 'customers', kind: 'table', fields: ['customer_id', 'name', 'email', 'phone', 'billing_address', 'created_at'] },
      { name: 'products', kind: 'table', fields: ['product_id', 'product_name', 'category', 'list_price'] },
      { name: 'monthly_revenue', kind: 'view', fields: ['month', 'revenue', 'orders'] },
    ],
  },
  mysql: {
    namespace: 'app',
    entities: [
      { name: 'accounts', kind: 'table', fields: ['company', 'plan', 'mrr', 'renewal_date', 'health'] },
      { name: 'contacts', kind: 'table', fields: ['name', 'email', 'phone', 'company'] },
      { name: 'notes', kind: 'table', fields: ['account', 'author', 'body', 'created_at'] },
    ],
  },
  sqlserver: {
    namespace: 'dbo',
    entities: [
      { name: 'employees', kind: 'table', fields: ['employee_id', 'department', 'start_date', 'email', 'date_of_birth'] },
      { name: 'compensation', kind: 'table', fields: ['employee_id', 'salary', 'bonus'] },
    ],
  },
  oracle: {
    namespace: 'BILLING',
    entities: [
      { name: 'INVOICES', kind: 'table', fields: ['INVOICE_NO', 'CUSTOMER', 'AMOUNT', 'PAID'] },
      { name: 'PAYMENTS', kind: 'table', fields: ['PAYMENT_ID', 'INVOICE_NO', 'AMOUNT', 'CARD_NUMBER'] },
    ],
  },
  snowflake: {
    namespace: 'CORE',
    entities: [
      { name: 'TRANSACTIONS', kind: 'table', fields: ['TRANSACTION_ID', 'TRANSACTION_DATE', 'CUSTOMER_ID', 'AMOUNT_USD', 'CHANNEL', 'CARD_LAST4'] },
      { name: 'CUSTOMER_LTV', kind: 'view', fields: ['CUSTOMER_ID', 'LIFETIME_VALUE_USD', 'FIRST_ORDER_DATE'] },
      { name: 'WEB_EVENTS', kind: 'table', fields: ['EVENT_ID', 'EVENT_TIME', 'USER_ID', 'IP_ADDRESS', 'PAGE'] },
    ],
  },
  mongodb: {
    namespace: 'app',
    entities: [
      { name: 'orders', kind: 'collection', fields: ['orderId', 'status', 'customer.name', 'customer.email', 'items', 'shipping.status'] },
      { name: 'tickets', kind: 'collection', fields: ['ticketId', 'subject', 'customer.email', 'status', 'priority'] },
    ],
  },
  redis: {
    namespace: 'db0',
    entities: [
      { name: 'stats:*', kind: 'keyPattern', fields: [] },
      { name: 'flags:*', kind: 'keyPattern', fields: [] },
      { name: 'session:*', kind: 'keyPattern', fields: [] },
      { name: 'leaderboard:*', kind: 'keyPattern', fields: [] },
    ],
  },
};

function guessType(name: string) {
  if (/date|_at$|time/i.test(name)) return 'timestamp';
  if (/amount|price|mrr|salary|bonus|value|usd/i.test(name)) return 'numeric';
  if (/_id$|id$/i.test(name)) return 'bigint';
  return 'text';
}

function filterAudit(filters: AuditFilters) {
  const rangeMs = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000 }[filters.range ?? '7d'];
  const since = Date.now() - rangeMs;
  const q = filters.q?.toLowerCase();
  const who = filters.user?.toLowerCase();
  return db.audit.filter(
    (entry) =>
      Date.parse(entry.timestamp) >= since &&
      (!q || entry.question?.toLowerCase().includes(q)) &&
      (!who || entry.user.name.toLowerCase().includes(who) || entry.user.email.toLowerCase().includes(who)) &&
      (!filters.sourceId || entry.sources.some((source) => source.id === filters.sourceId)) &&
      (!filters.action || entry.action === filters.action) &&
      (!filters.outcome || entry.outcome === filters.outcome) &&
      (!filters.queryId || entry.queryId === filters.queryId),
  );
}

function readAuditFilters(url: URL): AuditFilters {
  const get = (key: string) => url.searchParams.get(key) ?? undefined;
  return {
    q: get('q'),
    user: get('user'),
    sourceId: get('sourceId'),
    action: get('action') as AuditFilters['action'],
    outcome: get('outcome') as AuditFilters['outcome'],
    range: (get('range') as AuditFilters['range']) ?? '7d',
    queryId: get('queryId'),
    page: Number(get('page') ?? 1),
    pageSize: Math.min(100, Number(get('pageSize') ?? 25)),
  };
}

function resultToCsvRows(result: SingleResult): { header: string[]; rows: unknown[][] } {
  if (result.kind === 'table') {
    return {
      header: result.columns.map((column) => column.label),
      rows: result.rows.map((row) => result.columns.map((column) => (column.masked ? '[hidden]' : row[column.key]))),
    };
  }
  if (result.kind === 'documents') {
    const table = documentsToTable(result.documents, result.maskedPaths);
    return {
      header: table.columns.map((column) => column.label),
      rows: table.rows.map((row) => table.columns.map((column) => (column.masked ? '[hidden]' : row[column.key]))),
    };
  }
  return {
    header: ['key', 'type', 'value'],
    rows: result.entries.map((entry) => [entry.key, entry.type, entry.masked ? '[hidden]' : JSON.stringify(entry.value)]),
  };
}

/* ───────────────────────── handlers ───────────────────────── */

export const handlers = [
  /* Auth */
  http.get('/api/auth/providers', () =>
    json([
      { id: 'company', label: 'your company account' },
      { id: 'google', label: 'Google' },
    ]),
  ),

  http.get('/api/auth/session', async () => {
    await sleep(120);
    return session ? json(sessionPayload()) : fail(401, 'unauthorized', 'Not signed in.');
  }),

  http.post('/api/auth/demo-login', async ({ request }) => {
    const { role } = await body<{ role: Role }>(request);
    if (!role || !(role in db.DEMO_USERS)) return fail(400, 'invalid_role', 'Unknown demo role.');
    session = createSession(role);
    try {
      window.sessionStorage.setItem(SESSION_KEY, role);
    } catch {
      // ignore
    }
    record(db.DEMO_USERS[role], { action: 'login', outcome: 'success', sources: [] });
    await sleep(250);
    return json(sessionPayload());
  }),

  http.post('/api/auth/logout', () => {
    if (session) record(currentUser(), { action: 'logout', outcome: 'success', sources: [] });
    session = null;
    try {
      window.sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // ignore
    }
    return json({});
  }),

  /* Me */
  http.get('/api/me/preferences', ({ request }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    return json(db.preferences.get(g.user.id) ?? { showGeneratedQuery: false, defaultSourceIds: [] });
  }),

  http.put('/api/me/preferences', async ({ request }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    const input = await body<{ showGeneratedQuery: boolean; defaultSourceIds: string[] }>(request);
    const allowed = allowedSourceIds(g.user);
    const next = {
      showGeneratedQuery: Boolean(input.showGeneratedQuery) && g.user.permissions.canViewQuery,
      defaultSourceIds: (input.defaultSourceIds ?? []).filter((id) => allowed.has(id)),
    };
    db.preferences.set(g.user.id, next);
    return json(next);
  }),

  /* Sources & catalog */
  http.get('/api/sources', async ({ request }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    await sleep(150);
    const allowed = allowedSourceIds(g.user);
    const summaries: SourceSummary[] = db.sources
      .filter((source) => source.enabled)
      .map((source) => ({
        id: source.id,
        name: source.name,
        type: source.type,
        description: source.description,
        status: source.status,
        exampleQuestions: source.exampleQuestions,
        access: allowed.has(source.id)
          ? 'granted'
          : db.accessRequests.some((item) => item.user.id === g.user.id && item.source.id === source.id && item.status === 'pending')
            ? 'pending'
            : 'none',
      }));
    return json(summaries);
  }),

  http.get('/api/sources/:id/catalog', async ({ request, params }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    const source = db.sources.find((item) => item.id === params.id);
    if (!source || !source.enabled) return fail(404, 'not_found', 'Data source not found.');
    if (!allowedSourceIds(g.user).has(source.id)) return fail(403, 'forbidden', "You don't have access to this data source.");
    await sleep(200);
    return json({
      source: { ...toAdminSource(source), access: 'granted', exampleQuestions: source.exampleQuestions },
      entities: source.exposed.map((entity) => ({ name: entity.name, kind: entity.kind, description: entity.description, fields: entity.fields })),
      glossary: source.glossary,
    });
  }),

  http.post('/api/access-requests', async ({ request }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    const { sourceId, reason } = await body<{ sourceId: string; reason: string }>(request);
    const source = db.sources.find((item) => item.id === sourceId);
    if (!source) return fail(404, 'not_found', 'Data source not found.');
    if (!reason || reason.trim().length < 10) return fail(400, 'invalid', 'Please give a reason.');
    const item: AccessRequest = {
      id: db.nextId('ar'),
      user: { id: g.user.id, name: g.user.name, email: g.user.email },
      source: sourceRef(source.id),
      reason: reason.trim().slice(0, 500),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    db.accessRequests.unshift(item);
    record(g.user, { action: 'access_requested', outcome: 'success', sources: [item.source], details: item.reason });
    return json(item, 201);
  }),

  /* Conversations */
  http.get('/api/conversations', ({ request }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    const items: ConversationSummary[] = [...db.conversations.values()]
      .filter((item) => item.ownerId === g.user.id)
      .map(({ id, title, pinned, updatedAt }) => ({ id, title, pinned, updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return json(items);
  }),

  http.get('/api/conversations/:id', async ({ request, params }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    const conversation = db.conversations.get(String(params.id));
    if (!conversation || conversation.ownerId !== g.user.id) return fail(404, 'not_found', 'Conversation not found.');
    await sleep(150);
    const { ownerId: _owner, ...rest } = conversation;
    return json({
      ...rest,
      messages: rest.messages.map((message) =>
        message.role === 'assistant' && message.answer ? { ...message, answer: stripForUser(message.answer, g.user) } : message,
      ),
    });
  }),

  http.patch('/api/conversations/:id', async ({ request, params }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    const conversation = db.conversations.get(String(params.id));
    if (!conversation || conversation.ownerId !== g.user.id) return fail(404, 'not_found', 'Conversation not found.');
    const patch = await body<{ title: string; pinned: boolean }>(request);
    if (typeof patch.title === 'string' && patch.title.trim()) conversation.title = patch.title.trim().slice(0, 120);
    if (typeof patch.pinned === 'boolean') conversation.pinned = patch.pinned;
    return json({ id: conversation.id, title: conversation.title, pinned: conversation.pinned, updatedAt: conversation.updatedAt });
  }),

  http.delete('/api/conversations/:id', ({ request, params }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    const conversation = db.conversations.get(String(params.id));
    if (!conversation || conversation.ownerId !== g.user.id) return fail(404, 'not_found', 'Conversation not found.');
    db.conversations.delete(conversation.id);
    return noContent();
  }),

  http.get('/api/saved-questions', ({ request }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    return json(db.savedQuestions.get(g.user.id) ?? []);
  }),

  http.post('/api/saved-questions', async ({ request }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    const { question, sourceIds } = await body<{ question: string; sourceIds: string[] }>(request);
    if (!question?.trim()) return fail(400, 'invalid', 'Question is required.');
    const list = db.savedQuestions.get(g.user.id) ?? [];
    const existing = list.find((item) => item.question === question.trim());
    if (existing) return json(existing);
    const item = { id: db.nextId('sq'), question: question.trim(), sourceIds: sourceIds ?? [], createdAt: new Date().toISOString() };
    db.savedQuestions.set(g.user.id, [item, ...list]);
    return json(item, 201);
  }),

  http.delete('/api/saved-questions/:id', ({ request, params }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    db.savedQuestions.set(g.user.id, (db.savedQuestions.get(g.user.id) ?? []).filter((item) => item.id !== params.id));
    return noContent();
  }),

  /* Queries (streamed) */
  http.post('/api/queries', async ({ request }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    const input = await body<{ conversationId: string; question: string; sourceIds: string[] }>(request);
    const question = input.question?.trim() ?? '';
    if (!question || question.length > 2000) return fail(400, 'invalid', 'Please enter a question (up to 2,000 characters).');

    let conversation = input.conversationId ? db.conversations.get(input.conversationId) : undefined;
    if (conversation && conversation.ownerId !== g.user.id) return fail(404, 'not_found', 'Conversation not found.');
    const now = new Date().toISOString();
    if (!conversation) {
      conversation = { id: db.nextId('c'), ownerId: g.user.id, title: question.slice(0, 80), pinned: false, updatedAt: now, messages: [] };
      db.conversations.set(conversation.id, conversation);
    }
    const assistantId = db.nextId('m');
    conversation.messages.push(
      { id: db.nextId('m'), role: 'user', content: question, createdAt: now },
      { id: assistantId, role: 'assistant', createdAt: now, status: 'running', stage: 'understanding' },
    );
    conversation.updatedAt = now;

    const allowed = allowedSourceIds(g.user);
    const recordItem: QueryRecord = {
      id: db.nextId('q'),
      userId: g.user.id,
      question,
      sourceIds: g.user.permissions.canChooseSource ? (input.sourceIds ?? []).filter((id) => allowed.has(id)) : [],
      conversationId: conversation.id,
      assistantMessageId: assistantId,
    };
    queries.set(recordItem.id, recordItem);
    const user = g.user;
    return sse((emit) => runQuery(recordItem, user, emit));
  }),

  http.post('/api/queries/:id/clarify', async ({ request, params }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    const recordItem = ownedQuery(String(params.id), g.user);
    if (!recordItem) return fail(404, 'not_found', 'Question not found.');
    const { optionId } = await body<{ optionId: string }>(request);
    const option = recordItem.clarificationOptions?.find((item) => item.id === optionId);
    if (!option) return fail(400, 'invalid', 'Unknown option.');
    recordItem.clarificationOptionId = option.id;
    storeAssistant(recordItem, { status: 'running', clarificationAnswer: option.label });
    const user = g.user;
    return sse((emit) => runQuery(recordItem, user, emit, { resume: true }));
  }),

  http.post('/api/queries/:id/confirm', ({ request, params }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    const recordItem = ownedQuery(String(params.id), g.user);
    if (!recordItem) return fail(404, 'not_found', 'Question not found.');
    recordItem.confirmed = true;
    storeAssistant(recordItem, { status: 'running' });
    const user = g.user;
    return sse((emit) => runQuery(recordItem, user, emit, { resume: true }));
  }),

  http.post('/api/queries/:id/refresh', async ({ request, params }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    const original = ownedQuery(String(params.id), g.user);
    if (!original) return fail(404, 'not_found', 'Question not found.');
    const recordItem: QueryRecord = { ...original, id: db.nextId('q'), answer: undefined, cancelled: false, confirmed: true };
    queries.set(recordItem.id, recordItem);
    const user = g.user;
    return sse((emit) => runQuery(recordItem, user, emit, { refresh: true }));
  }),

  http.post('/api/queries/:id/cancel', ({ request, params }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    const recordItem = ownedQuery(String(params.id), g.user);
    if (!recordItem) return noContent();
    if (!recordItem.answer) {
      recordItem.cancelled = true;
      storeAssistant(recordItem, { status: 'cancelled', stage: undefined });
      record(g.user, { action: 'query', outcome: 'cancelled', queryId: recordItem.id, question: recordItem.question, sources: [] });
    }
    return noContent();
  }),

  http.post('/api/queries/:id/export', async ({ request, params }) => {
    const g = guard(request, 'canExport');
    if (!g.ok) return g.response;
    const recordItem = ownedQuery(String(params.id), g.user);
    if (!recordItem?.answer) return fail(404, 'not_found', 'Nothing to export for this question.');
    const result = recordItem.answer.result.kind === 'multi' ? recordItem.answer.result.parts[0].result : recordItem.answer.result;
    const { header, rows } = resultToCsvRows(result);
    const limited = rows.slice(0, g.user.permissions.exportRowLimit);
    const stamp = new Date().toISOString();
    const watermark = toCsv([`Confidential — exported from CodeLens by ${g.user.name} <${g.user.email}> at ${stamp}. Do not share outside the company.`], []);
    record(g.user, {
      action: 'export',
      outcome: 'success',
      queryId: recordItem.id,
      question: recordItem.question,
      sources: recordItem.answer.sources,
      rowsReturned: limited.length,
    });
    await sleep(300);
    return csvResponse(`${watermark}\r\n${toCsv(header, limited)}`, `codelens-export-${stamp.slice(0, 10)}.csv`);
  }),

  http.post('/api/feedback', async ({ request }) => {
    const g = guard(request);
    if (!g.ok) return g.response;
    const input = await body<{ queryId: string; rating: 'up' | 'down'; reason: string; comment: string }>(request);
    const recordItem = input.queryId ? ownedQuery(input.queryId, g.user) : undefined;
    if (input.rating === 'down' && recordItem) {
      db.feedback.unshift({
        id: db.nextId('fb'),
        queryId: recordItem.id,
        question: recordItem.question,
        user: g.user.name,
        reason: (input.reason as never) ?? 'other',
        comment: input.comment?.slice(0, 1000),
        createdAt: new Date().toISOString(),
      });
    }
    return noContent();
  }),

  /* Admin: sources */
  http.get('/api/admin/sources', async ({ request }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    await sleep(180);
    return json(db.sources.map(toAdminSource));
  }),

  http.post('/api/admin/sources/test', async ({ request }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    const input = await body<{ type: SourceType; connection: Record<string, unknown> }>(request);
    await sleep(900);
    const host = String(input.connection?.host ?? input.connection?.hosts ?? input.connection?.account ?? '');
    const username = String(input.connection?.username ?? '').toLowerCase();
    if (host.includes('fail') || host.includes('unknown')) {
      return json({ ok: false, readOnly: false, message: `Could not reach ${host}. Check the hostname, port and firewall rules.`, warnings: [] });
    }
    const writable = /^(admin|root|sa|postgres|sysadmin|dbo|accountadmin)$/.test(username) || username.includes('admin');
    const versions: Record<SourceType, string> = {
      postgresql: 'PostgreSQL 16.4',
      mysql: 'MySQL 8.4.2',
      sqlserver: 'SQL Server 2022 (16.0)',
      oracle: 'Oracle Database 19c',
      snowflake: 'Snowflake 8.38',
      mongodb: 'MongoDB 7.0.12',
      redis: 'Redis 7.4.1',
    };
    return json({
      ok: true,
      readOnly: !writable,
      latencyMs: 40 + Math.floor(Math.random() * 80),
      serverVersion: input.type ? versions[input.type] : undefined,
      message: writable ? 'The account has write permissions.' : 'Connection is encrypted.',
      warnings: input.type === 'snowflake' ? ['Queries on this warehouse use compute credits. Set a sensible timeout.'] : [],
    });
  }),

  http.post('/api/admin/sources/discover', async ({ request }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    const input = await body<{ sourceId: string; type: SourceType }>(request);
    await sleep(700);
    const type = input.type ?? 'postgresql';
    const discovery = DISCOVERY[type];
    const schema: DiscoveredSchema = {
      namespaces: [
        {
          name: discovery.namespace,
          entities: discovery.entities.map((entity) => ({
            name: entity.name,
            kind: entity.kind,
            fields: entity.fields.map((name) => ({ name, type: guessType(name) })),
          })),
        },
      ],
    };
    return json(schema);
  }),

  http.get('/api/admin/sources/:id', async ({ request, params }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    const source = db.sources.find((item) => item.id === params.id);
    if (!source) return fail(404, 'not_found', 'Data source not found.');
    await sleep(200);
    return json(source);
  }),

  http.post('/api/admin/sources', async ({ request }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    const input = await body<AdminSourceDetail & { secrets: Record<string, string> }>(request);
    if (!input.name || !input.type) return fail(400, 'invalid', 'Name and type are required.');
    const baseId = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'source';
    const id = db.sources.some((item) => item.id === baseId) ? `${baseId}-${db.nextId('s').slice(-4)}` : baseId;
    const now = new Date().toISOString();
    const source: AdminSourceDetail = {
      id,
      name: input.name,
      type: input.type,
      description: input.description ?? '',
      status: 'healthy',
      lastCheckedAt: now,
      owner: g.user.name,
      enabled: true,
      exposedCount: input.exposed?.length ?? 0,
      cacheTtlSeconds: input.cacheTtlSeconds ?? 900,
      connection: input.connection ?? {},
      // Secret VALUES are discarded immediately — only "is set" is kept (the real backend stores them in a vault).
      secrets: Object.fromEntries(Object.keys(input.secrets ?? {}).map((key) => [key, { isSet: true, updatedAt: now }])),
      exposed: input.exposed ?? [],
      glossary: input.glossary ?? [],
      exampleQuestions: input.exampleQuestions ?? [],
      roleIds: input.roleIds ?? [],
      rowLimit: input.rowLimit ?? 500,
      queryTimeoutSeconds: input.queryTimeoutSeconds ?? 30,
    };
    db.sources.push(source);
    for (const role of db.roles) if (source.roleIds.includes(role.id)) role.sourceIds.push(source.id);
    cacheStats.set(source.id, { hits: 0, misses: 0, baseEntries: 0 });
    record(g.user, { action: 'source_created', outcome: 'success', sources: [sourceRef(source.id)], details: `Exposed ${source.exposed.length} entities` });
    await sleep(400);
    return json(source, 201);
  }),

  http.put('/api/admin/sources/:id', async ({ request, params }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    const source = db.sources.find((item) => item.id === params.id);
    if (!source) return fail(404, 'not_found', 'Data source not found.');
    const input = await body<AdminSourceDetail & { secrets: Record<string, string> }>(request);
    const now = new Date().toISOString();
    Object.assign(source, {
      name: input.name ?? source.name,
      description: input.description ?? source.description,
      connection: input.connection ?? source.connection,
      exposed: input.exposed ?? source.exposed,
      glossary: input.glossary ?? source.glossary,
      exampleQuestions: input.exampleQuestions ?? source.exampleQuestions,
      roleIds: input.roleIds ?? source.roleIds,
      rowLimit: input.rowLimit ?? source.rowLimit,
      queryTimeoutSeconds: input.queryTimeoutSeconds ?? source.queryTimeoutSeconds,
      cacheTtlSeconds: input.cacheTtlSeconds ?? source.cacheTtlSeconds,
    });
    source.exposedCount = source.exposed.length;
    for (const key of Object.keys(input.secrets ?? {})) source.secrets[key] = { isSet: true, updatedAt: now };
    for (const role of db.roles) {
      const has = role.sourceIds.includes(source.id);
      if (source.roleIds.includes(role.id) && !has) role.sourceIds.push(source.id);
      if (!source.roleIds.includes(role.id) && has) role.sourceIds = role.sourceIds.filter((id) => id !== source.id);
    }
    record(g.user, {
      action: 'source_updated',
      outcome: 'success',
      sources: [sourceRef(source.id)],
      details: Object.keys(input.secrets ?? {}).length ? 'Settings and credentials updated' : 'Settings updated',
    });
    await sleep(400);
    return json(source);
  }),

  http.patch('/api/admin/sources/:id', async ({ request, params }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    const source = db.sources.find((item) => item.id === params.id);
    if (!source) return fail(404, 'not_found', 'Data source not found.');
    const { enabled } = await body<{ enabled: boolean }>(request);
    if (typeof enabled === 'boolean') source.enabled = enabled;
    record(g.user, { action: 'source_updated', outcome: 'success', sources: [sourceRef(source.id)], details: enabled ? 'Enabled' : 'Disabled' });
    return json(toAdminSource(source));
  }),

  http.delete('/api/admin/sources/:id', ({ request, params }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    const index = db.sources.findIndex((item) => item.id === params.id);
    if (index === -1) return fail(404, 'not_found', 'Data source not found.');
    const [removed] = db.sources.splice(index, 1);
    for (const role of db.roles) role.sourceIds = role.sourceIds.filter((id) => id !== removed.id);
    record(g.user, {
      action: 'source_deleted',
      outcome: 'success',
      sources: [{ id: removed.id, name: removed.name, type: removed.type }],
      details: 'Stored credentials deleted',
    });
    return noContent();
  }),

  http.post('/api/admin/sources/:id/check', async ({ request, params }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    const source = db.sources.find((item) => item.id === params.id);
    if (!source) return fail(404, 'not_found', 'Data source not found.');
    await sleep(700);
    source.lastCheckedAt = new Date().toISOString();
    return json(toAdminSource(source));
  }),

  /* Admin: users, roles, access requests */
  http.get('/api/admin/users', ({ request }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    return json(db.users);
  }),

  http.put('/api/admin/users/:id/roles', async ({ request, params }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    const target = db.users.find((item) => item.id === params.id);
    if (!target) return fail(404, 'not_found', 'User not found.');
    const { roleIds } = await body<{ roleIds: string[] }>(request);
    target.roleIds = (roleIds ?? []).filter((id) => db.roles.some((role) => role.id === id));
    recomputeMemberCounts();
    record(g.user, { action: 'role_changed', outcome: 'success', sources: [], details: `${target.name}: ${target.roleIds.join(', ') || 'no roles'}` });
    return json(target);
  }),

  http.get('/api/admin/roles', ({ request }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    return json(db.roles);
  }),

  http.post('/api/admin/roles', async ({ request }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    const input = await body<RoleDefinition>(request);
    if (!input.name?.trim() || !input.permissions) return fail(400, 'invalid', 'Name and permissions are required.');
    const role: RoleDefinition = {
      id: db.nextId('role'),
      name: input.name.trim(),
      description: input.description ?? '',
      permissions: input.permissions,
      sourceIds: input.sourceIds ?? [],
      memberCount: 0,
      builtIn: false,
    };
    db.roles.push(role);
    record(g.user, { action: 'role_changed', outcome: 'success', sources: [], details: `Created role ${role.name}` });
    return json(role, 201);
  }),

  http.put('/api/admin/roles/:id', async ({ request, params }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    const role = db.roles.find((item) => item.id === params.id);
    if (!role) return fail(404, 'not_found', 'Role not found.');
    const input = await body<RoleDefinition>(request);
    role.name = input.name?.trim() || role.name;
    role.description = input.description ?? role.description;
    role.permissions = input.permissions ?? role.permissions;
    role.sourceIds = input.sourceIds ?? role.sourceIds;
    for (const source of db.sources) {
      const allowed = role.sourceIds.includes(source.id);
      if (allowed && !source.roleIds.includes(role.id)) source.roleIds.push(role.id);
      if (!allowed) source.roleIds = source.roleIds.filter((id) => id !== role.id);
    }
    record(g.user, { action: 'role_changed', outcome: 'success', sources: [], details: `Updated role ${role.name}` });
    return json(role);
  }),

  http.get('/api/admin/access-requests', ({ request }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    const status = new URL(request.url).searchParams.get('status');
    return json(status ? db.accessRequests.filter((item) => item.status === status) : db.accessRequests);
  }),

  http.post('/api/admin/access-requests/:id/decision', async ({ request, params }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    const item = db.accessRequests.find((entry) => entry.id === params.id);
    if (!item) return fail(404, 'not_found', 'Request not found.');
    if (item.status !== 'pending') return fail(409, 'conflict', 'This request was already decided.');
    const { decision, note } = await body<{ decision: 'approve' | 'reject'; note: string }>(request);
    item.status = decision === 'approve' ? 'approved' : 'rejected';
    item.decidedBy = g.user.name;
    item.decidedAt = new Date().toISOString();
    item.note = note?.slice(0, 300) || undefined;
    if (item.status === 'approved') {
      const grants = db.userGrants.get(item.user.id) ?? new Set<string>();
      grants.add(item.source.id);
      db.userGrants.set(item.user.id, grants);
    }
    record(g.user, {
      action: 'access_decision',
      outcome: 'success',
      sources: [item.source],
      details: `${item.status === 'approved' ? 'Approved' : 'Rejected'} access for ${item.user.name}`,
    });
    return json(item);
  }),

  /* Admin: cache & metrics */
  http.get('/api/admin/cache', ({ request }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    return json(cacheOverview());
  }),

  http.patch('/api/admin/cache/sources/:id', async ({ request, params }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    const source = db.sources.find((item) => item.id === params.id);
    if (!source) return fail(404, 'not_found', 'Data source not found.');
    const { ttlSeconds } = await body<{ ttlSeconds: number }>(request);
    if (typeof ttlSeconds !== 'number' || ttlSeconds < 0 || ttlSeconds > 7 * 86_400) return fail(400, 'invalid', 'Invalid cache duration.');
    source.cacheTtlSeconds = ttlSeconds;
    record(g.user, { action: 'source_updated', outcome: 'success', sources: [sourceRef(source.id)], details: `Cache duration set to ${ttlSeconds}s` });
    return json(cacheOverview());
  }),

  http.post('/api/admin/cache/clear', async ({ request }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    const { sourceId } = await body<{ sourceId: string }>(request);
    for (const [key, entry] of answerCache) if (!sourceId || entry.sourceIds.includes(sourceId)) answerCache.delete(key);
    for (const [id, stats] of cacheStats) if (!sourceId || id === sourceId) stats.baseEntries = 0;
    record(g.user, { action: 'cache_cleared', outcome: 'success', sources: sourceId ? [sourceRef(sourceId)] : [] });
    await sleep(300);
    return json(cacheOverview());
  }),

  http.get('/api/admin/metrics', async ({ request }) => {
    const g = guard(request, 'canAdmin');
    if (!g.ok) return g.response;
    await sleep(250);
    const range = new URL(request.url).searchParams.get('range') === '30d' ? '30d' : '7d';
    return json(buildMetrics(range));
  }),

  /* Audit */
  http.get('/api/audit', async ({ request }) => {
    const g = guard(request, 'canAudit');
    if (!g.ok) return g.response;
    await sleep(200);
    const filters = readAuditFilters(new URL(request.url));
    const all = filterAudit(filters);
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = filters.pageSize ?? 25;
    return json({ items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize });
  }),

  http.post('/api/audit/export', async ({ request }) => {
    const g = guard(request, 'canAudit');
    if (!g.ok) return g.response;
    const filters = await body<AuditFilters>(request);
    const entries = filterAudit({ ...filters, range: filters.range ?? '7d' });
    record(g.user, { action: 'export', outcome: 'success', sources: [], rowsReturned: entries.length, details: 'Audit log export' });
    const csv = toCsv(
      ['timestamp', 'user', 'email', 'action', 'outcome', 'question', 'sources', 'rows', 'cached', 'duration_ms', 'ip_address', 'details'],
      entries.map((entry) => [
        entry.timestamp,
        entry.user.name,
        entry.user.email,
        entry.action,
        entry.outcome,
        entry.question ?? '',
        entry.sources.map((source) => source.name).join('; '),
        entry.rowsReturned ?? '',
        entry.cached ?? '',
        entry.durationMs ?? '',
        entry.ipAddress ?? '',
        entry.details ?? '',
      ]),
    );
    return csvResponse(csv, `codelens-audit-${new Date().toISOString().slice(0, 10)}.csv`);
  }),
];
