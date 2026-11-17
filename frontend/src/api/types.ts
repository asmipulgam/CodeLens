/**
 * API contract between the CodeLens frontend and backend.
 * docs/api-contract.md describes each endpoint; this file is the source of truth for shapes.
 */

/* ───────────────────────── Auth & users ───────────────────────── */

export type Role = 'business' | 'analyst' | 'admin' | 'auditor';

/** What the signed-in user may do. Computed by the backend; the UI only uses it to hide controls. */
export interface Permissions {
  canViewQuery: boolean;
  canExport: boolean;
  canChooseSource: boolean;
  canAdmin: boolean;
  canAudit: boolean;
  exportRowLimit: number;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  roles: Role[];
  permissions: Permissions;
}

export interface Session {
  user: SessionUser;
  /** Sent back in the X-CSRF-Token header on every state-changing request. Kept in memory only. */
  csrfToken: string;
  /** Absolute session expiry (ISO). */
  expiresAt: string;
  idleTimeoutSeconds: number;
  /** Until when sensitive admin changes are allowed without signing in again (step-up). ISO. */
  recentAuthUntil: string;
}

/** A way to sign in, as offered by the backend (e.g. the company provider, Google). */
export interface AuthProvider {
  id: string;
  label: string;
}

export interface Preferences {
  showGeneratedQuery: boolean;
  /** Empty = let CodeLens choose automatically. */
  defaultSourceIds: string[];
}

/* ───────────────────────── Data sources ───────────────────────── */

export type SourceType = 'postgresql' | 'mysql' | 'sqlserver' | 'oracle' | 'snowflake' | 'mongodb' | 'redis';
export type SourceHealth = 'healthy' | 'degraded' | 'offline';
export type SourceAccess = 'granted' | 'none' | 'pending';

export interface SourceRef {
  id: string;
  name: string;
  type: SourceType;
}

export interface SourceSummary extends SourceRef {
  description: string;
  status: SourceHealth;
  access: SourceAccess;
  exampleQuestions: string[];
}

export type EntityKind = 'table' | 'view' | 'collection' | 'keyPattern';

export interface CatalogField {
  name: string;
  type: string;
  description: string;
  masked: boolean;
}

export interface CatalogEntity {
  name: string;
  kind: EntityKind;
  description: string;
  fields: CatalogField[];
}

export interface GlossaryTerm {
  term: string;
  definition: string;
}

export interface SourceCatalog {
  source: SourceSummary;
  entities: CatalogEntity[];
  glossary: GlossaryTerm[];
}

/* ───────────────────────── Conversations ───────────────────────── */

export interface ConversationSummary {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: string;
}

export interface Conversation extends ConversationSummary {
  messages: Message[];
}

export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
  createdAt: string;
}

export type AssistantStatus =
  | 'running'
  | 'needs_clarification'
  | 'needs_confirmation'
  | 'done'
  | 'error'
  | 'cancelled';

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  createdAt: string;
  queryId?: string;
  status: AssistantStatus;
  stage?: QueryStage;
  clarification?: Clarification;
  /** Label of the option the user picked when asked to clarify. */
  clarificationAnswer?: string;
  confirmation?: Confirmation;
  answer?: Answer;
  error?: QueryError;
  /** True while a cache-bypassing refresh of an existing answer is running. */
  refreshing?: boolean;
}

export type Message = UserMessage | AssistantMessage;

export interface SavedQuestion {
  id: string;
  question: string;
  sourceIds: string[];
  createdAt: string;
}

/* ───────────────────────── Asking questions ───────────────────────── */

export type QueryStage = 'understanding' | 'routing' | 'building' | 'running' | 'summarising';

export interface AskRequest {
  conversationId?: string;
  question: string;
  /** Empty = automatic routing. */
  sourceIds: string[];
}

export interface Clarification {
  question: string;
  options: { id: string; label: string; description?: string }[];
}

export interface Confirmation {
  message: string;
  source?: SourceRef;
  estimate: {
    bytesScanned?: number;
    seconds?: number;
    rows?: number;
    credits?: number;
  };
}

export type QueryErrorCode =
  | 'forbidden'
  | 'timeout'
  | 'source_offline'
  | 'not_understood'
  | 'too_large'
  | 'rate_limited'
  | 'write_blocked'
  | 'internal';

export interface QueryError {
  code: QueryErrorCode;
  message: string;
  hint?: string;
  source?: SourceRef;
  canRequestAccess?: boolean;
}

export type ColumnType = 'string' | 'number' | 'currency' | 'percent' | 'date' | 'datetime' | 'boolean';

export interface Column {
  key: string;
  label: string;
  type: ColumnType;
  /** Values in this column were hidden by data policy; they arrive as null. */
  masked?: boolean;
  currency?: string;
}

export type CellValue = string | number | boolean | null;

export interface TableResult {
  kind: 'table';
  columns: Column[];
  rows: Record<string, CellValue>[];
  /** Total rows the query matched (may exceed rows returned). */
  totalRows: number;
}

export interface DocumentsResult {
  kind: 'documents';
  documents: Record<string, unknown>[];
  totalRows: number;
  /** Dot paths whose values were hidden by data policy (arrive as null). */
  maskedPaths: string[];
}

export type RedisValue =
  | { type: 'string'; value: string | null }
  | { type: 'hash'; value: Record<string, string | null> }
  | { type: 'list'; value: (string | null)[] }
  | { type: 'set'; value: (string | null)[] }
  | { type: 'zset'; value: { member: string; score: number }[] };

export type RedisEntry = RedisValue & {
  key: string;
  ttlSeconds: number | null;
  masked?: boolean;
};

export interface KeyValueResult {
  kind: 'keyvalue';
  entries: RedisEntry[];
  totalRows: number;
}

export type SingleResult = TableResult | DocumentsResult | KeyValueResult;

export interface MultiResult {
  kind: 'multi';
  parts: { source: SourceRef; result: SingleResult }[];
}

export type ResultSet = SingleResult | MultiResult;

export interface ChartSpec {
  type: 'bar' | 'line';
  /** Column key for the category / time axis. */
  x: string;
  /** Column keys plotted as series. All must share one unit (one y-axis). */
  series: string[];
}

export interface GeneratedQuery {
  source: SourceRef;
  language: 'sql' | 'mongodb' | 'redis';
  text: string;
}

export interface Answer {
  queryId: string;
  question: string;
  summary: string;
  highlights: { label: string; value: string }[];
  sources: SourceRef[];
  freshness: { status: 'live' | 'cached'; cachedAt?: string; durationMs: number };
  /** Plain-English description of how the answer was produced. */
  explanation: string;
  /** Only present when the user's role may see generated queries. */
  generatedQueries?: GeneratedQuery[];
  result: ResultSet;
  chart?: ChartSpec;
  followUps: string[];
  /** Maximum rows the UI receives for display. */
  rowLimit: number;
}

/** Server-sent events streamed while a question is answered. */
export type QueryEvent =
  | { type: 'started'; queryId: string; conversationId: string }
  | { type: 'progress'; stage: QueryStage; detail?: string }
  | { type: 'clarification'; clarification: Clarification }
  | { type: 'confirmation'; confirmation: Confirmation }
  | { type: 'result'; answer: Answer }
  | { type: 'error'; error: QueryError };

export type FeedbackReason = 'wrong_numbers' | 'wrong_source' | 'did_not_answer' | 'too_slow' | 'other';

export interface FeedbackInput {
  queryId: string;
  rating: 'up' | 'down';
  reason?: FeedbackReason;
  comment?: string;
}

/* ───────────────────────── Admin ───────────────────────── */

export interface AdminSource extends SourceRef {
  description: string;
  status: SourceHealth;
  lastCheckedAt: string;
  owner: string;
  enabled: boolean;
  exposedCount: number;
  cacheTtlSeconds: number;
}

export interface SecretStatus {
  isSet: boolean;
  updatedAt?: string;
}

export interface ExposedField {
  name: string;
  type: string;
  description: string;
  masked: boolean;
}

export interface ExposedEntity {
  namespace: string;
  name: string;
  kind: EntityKind;
  description: string;
  fields: ExposedField[];
}

export type ConnectionValues = Record<string, string | number | boolean>;

export interface AdminSourceDetail extends AdminSource {
  /** Non-secret connection settings only. Secrets are never returned. */
  connection: ConnectionValues;
  secrets: Record<string, SecretStatus>;
  exposed: ExposedEntity[];
  glossary: GlossaryTerm[];
  exampleQuestions: string[];
  roleIds: string[];
  rowLimit: number;
  queryTimeoutSeconds: number;
}

export interface SourceConfigInput {
  name: string;
  type: SourceType;
  description: string;
  connection: ConnectionValues;
  /** Only secrets that are new or being replaced. Omitted keys keep their stored value. */
  secrets: Record<string, string>;
  exposed: ExposedEntity[];
  glossary: GlossaryTerm[];
  exampleQuestions: string[];
  roleIds: string[];
  rowLimit: number;
  queryTimeoutSeconds: number;
  cacheTtlSeconds: number;
}

export interface ConnectionProbeInput {
  /** Present when editing: the backend fills in stored secrets that weren't replaced. */
  sourceId?: string;
  type: SourceType;
  connection: ConnectionValues;
  secrets: Record<string, string>;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  serverVersion?: string;
  /** True only when the account cannot modify data. Required before saving. */
  readOnly: boolean;
  warnings: string[];
}

export interface DiscoveredSchema {
  namespaces: {
    name: string;
    entities: { name: string; kind: EntityKind; fields: { name: string; type: string }[] }[];
  }[];
}

export interface RoleDefinition {
  id: string;
  name: string;
  description: string;
  permissions: Permissions;
  sourceIds: string[];
  memberCount: number;
  builtIn: boolean;
}

export type RoleInput = Pick<RoleDefinition, 'name' | 'description' | 'permissions' | 'sourceIds'>;

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  roleIds: string[];
  groups: string[];
  lastActiveAt: string | null;
  status: 'active' | 'disabled';
}

export type AccessRequestStatus = 'pending' | 'approved' | 'rejected';

export interface AccessRequest {
  id: string;
  user: { id: string; name: string; email: string };
  source: SourceRef;
  reason: string;
  status: AccessRequestStatus;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

export interface CacheOverview {
  hitRate: number;
  entries: number;
  sizeBytes: number;
  sources: {
    source: SourceRef;
    ttlSeconds: number;
    hitRate: number;
    entries: number;
    sizeBytes: number;
  }[];
}

export type MetricsRange = '7d' | '30d';

export interface UsageTotals {
  questions: number;
  activeUsers: number;
  cacheHitRate: number;
  p95LatencyMs: number;
  failedQueries: number;
}

export interface FeedbackItem {
  id: string;
  queryId: string;
  question: string;
  user: string;
  reason: FeedbackReason;
  comment?: string;
  createdAt: string;
}

export interface UsageMetrics {
  range: MetricsRange;
  totals: UsageTotals;
  previous: UsageTotals;
  daily: {
    date: string;
    live: number;
    cached: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    failed: number;
  }[];
  topSources: { source: SourceRef; questions: number }[];
  negativeFeedback: FeedbackItem[];
}

/* ───────────────────────── Audit ───────────────────────── */

export type AuditAction =
  | 'query'
  | 'refresh'
  | 'export'
  | 'login'
  | 'logout'
  | 'source_created'
  | 'source_updated'
  | 'source_deleted'
  | 'role_changed'
  | 'access_requested'
  | 'access_decision'
  | 'cache_cleared';

export type AuditOutcome = 'success' | 'denied' | 'error' | 'cancelled';

export interface AuditEntry {
  id: string;
  timestamp: string;
  user: { id: string; name: string; email: string };
  action: AuditAction;
  outcome: AuditOutcome;
  queryId?: string;
  question?: string;
  sources: SourceRef[];
  generatedQueries?: GeneratedQuery[];
  rowsReturned?: number;
  cached?: boolean;
  durationMs?: number;
  ipAddress?: string;
  details?: string;
}

export interface AuditFilters {
  q?: string;
  user?: string;
  sourceId?: string;
  action?: AuditAction | '';
  outcome?: AuditOutcome | '';
  range?: '24h' | '7d' | '30d' | '90d';
  queryId?: string;
  page?: number;
  pageSize?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
