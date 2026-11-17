# CodeLens API contract (frontend ⇄ backend)

The frontend talks to one backend (a "backend-for-frontend", BFF) under `/api` on the **same origin**.
Shapes are defined in [`src/api/types.ts`](../src/api/types.ts) — that file is the source of truth.
The mock backend in [`src/mocks/handlers.ts`](../src/mocks/handlers.ts) is a working reference implementation.

## Security requirements the backend must meet

The browser is not a security boundary. Everything below **must** be enforced server-side:

| # | Requirement |
|---|---|
| 1 | **Auth via OIDC Authorization Code + PKCE** with the company IdP (Keycloak / Entra ID / Okta). The BFF keeps all tokens; the browser only gets a session cookie: `HttpOnly; Secure; SameSite=Strict; Path=/`. MFA is enforced by the IdP. |
| 2 | **CSRF**: return a random `csrfToken` from `GET /api/auth/session`; require it in the `X-CSRF-Token` header on every non-GET request. Reject with `403 {code:"csrf_failed"}`. |
| 3 | **Never redirect API calls.** An expired session returns `401`, not a 302 to the IdP. Admin actions that need a fresh login return `401 {code:"step_up_required"}`. |
| 4 | **Idle + absolute session timeouts** (default 15 min idle / 8 h absolute). The UI warns the user, but the server decides. |
| 5 | **Authorise every request** by role and data source. Hidden buttons in the UI are only cosmetic. |
| 6 | **Read-only execution.** Generated queries run with read-only DB accounts, a statement allow-list (SELECT / aggregate / read commands), a row limit, and a timeout. Refuse writes with `write_blocked`. |
| 7 | **Masking happens on the server.** Masked values are sent as `null` and flagged (`Column.masked`, `DocumentsResult.maskedPaths`, `RedisEntry.masked`). Unmasked values never leave the server. |
| 8 | **Generated queries** (`Answer.generatedQueries`) are **omitted** unless the user's role has `canViewQuery`. |
| 9 | **Cache isolation.** The LangChain result cache key must include the user's permission scope (roles + source grants + masking policy), so cached rows never cross access boundaries. |
| 10 | **Secrets are write-only.** Connection secrets go to a vault (e.g. HashiCorp Vault / AWS Secrets Manager). `GET` responses only include `{ isSet, updatedAt }`. |
| 11 | **Audit everything**: questions, generated queries, sources, row counts, exports, admin changes, sign-ins. Append-only. |
| 12 | **Exports**: enforce `canExport` and `exportRowLimit`, neutralise spreadsheet formulas (`= + - @`), add a "Confidential — exported by …" line, and audit. |
| 13 | **Headers** on every API response: `Cache-Control: no-store`. Errors are JSON `{ "code": string, "message": string }` with no stack traces. |
| 14 | **Prompt-injection hygiene.** Treat database content as untrusted when it is fed back to the LLM; never let data change which tools or sources a query may use. |

## Errors

All non-2xx responses: `{ "code": "<machine_code>", "message": "<human sentence safe to show users>" }`.
Common codes: `unauthorized`, `step_up_required`, `csrf_failed`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `invalid`.
Data-source saves and schema discovery can also return `connection_failed` (couldn't connect) and `not_read_only`
(the account can change data).

## Endpoints

Permission column: who may call it (`any` = any signed-in user).

### Auth & profile
| Method | Path | Body → Response | Permission |
|---|---|---|---|
| GET | `/api/auth/providers` | → `AuthProvider[]` — the sign-in buttons to show (`company`, and `google` when configured) | public |
| GET | `/api/auth/session` | → `Session` or `401` | public |
| GET | `/api/auth/login?returnTo=/path[&provider=google][&prompt=login]` | Browser navigation → IdP redirect. Validate `returnTo` is a relative path. Step-up re-uses the current session's provider. Google sign-in admits only allow-listed, verified addresses and never grants admin. | public |
| POST | `/api/auth/logout` | → `{ redirectUrl?: string }` (IdP end-session URL) | any |
| GET / PUT | `/api/me/preferences` | `Preferences` | any |

### Data sources & catalog
| Method | Path | Body → Response | Permission |
|---|---|---|---|
| GET | `/api/sources` | → `SourceSummary[]` (with the caller's `access`) | any |
| GET | `/api/sources/:id/catalog` | → `SourceCatalog` | access to source |
| POST | `/api/access-requests` | `{ sourceId, reason }` → `AccessRequest` | any |

### Conversations
| Method | Path | Body → Response | Permission |
|---|---|---|---|
| GET | `/api/conversations` | → `ConversationSummary[]` (own only) | any |
| GET | `/api/conversations/:id` | → `Conversation` | owner |
| PATCH | `/api/conversations/:id` | `{ title?, pinned? }` → `ConversationSummary` | owner |
| DELETE | `/api/conversations/:id` | → `204` | owner |
| GET / POST | `/api/saved-questions` | `{ question, sourceIds }` → `SavedQuestion` | any |
| DELETE | `/api/saved-questions/:id` | → `204` | owner |

### Asking questions (streamed)
| Method | Path | Body | Permission |
|---|---|---|---|
| POST | `/api/queries` | `AskRequest` | any |
| POST | `/api/queries/:id/clarify` | `{ optionId }` | owner |
| POST | `/api/queries/:id/confirm` | `{}` | owner |
| POST | `/api/queries/:id/refresh` | `{}` — bypasses the cache | owner |
| POST | `/api/queries/:id/cancel` | → `204` | owner |
| POST | `/api/queries/:id/export` | `{ format: "csv" }` → `text/csv` attachment | `canExport` |
| POST | `/api/feedback` | `FeedbackInput` → `204` | any |

The four streaming endpoints respond with `Content-Type: text/event-stream`. Each event is:

```
event: <type>
data: <JSON-encoded QueryEvent>

```

Order: `started` → `progress`* → exactly one of `clarification` | `confirmation` | `result` | `error`.
`started` carries `{ queryId, conversationId }` (a new conversation is created when none was sent).
Stages: `understanding`, `routing`, `building`, `running`, `summarising`.
Send `confirmation` before expensive queries (e.g. large Snowflake scans) with an estimate.
If the database itself rejects a generated query, the `error` event uses `not_understood` with a general
message; the database's own error text goes only to logs and the audit trail. `timeout` and `source_offline`
carry the `source`. The backend also sends `X-Accel-Buffering: no` on these responses.
Disable proxy buffering for these routes (see `deploy/nginx.conf`).

### Admin (`canAdmin`)
| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/admin/sources` | → `AdminSource[]` |
| GET | `/api/admin/sources/:id` | → `AdminSourceDetail` (no secret values) |
| POST | `/api/admin/sources` | `SourceConfigInput` → `AdminSourceDetail` |
| PUT | `/api/admin/sources/:id` | `SourceConfigInput` (omitted secrets are kept) → `AdminSourceDetail` |
| PATCH | `/api/admin/sources/:id` | `{ enabled }` → `AdminSource` |
| DELETE | `/api/admin/sources/:id` | → `204` (delete secrets from the vault too) |
| POST | `/api/admin/sources/:id/check` | → `AdminSource` |
| POST | `/api/admin/sources/test` | `ConnectionProbeInput` → `ConnectionTestResult` — must verify the account is **read-only** |
| POST | `/api/admin/sources/discover` | `ConnectionProbeInput` → `DiscoveredSchema` |
| GET | `/api/admin/users` | → `AdminUser[]` |
| PUT | `/api/admin/users/:id/roles` | `{ roleIds }` → `AdminUser` |
| GET / POST | `/api/admin/roles` | `RoleInput` → `RoleDefinition` |
| PUT | `/api/admin/roles/:id` | `RoleInput` → `RoleDefinition` |
| GET | `/api/admin/access-requests?status=` | → `AccessRequest[]` |
| POST | `/api/admin/access-requests/:id/decision` | `{ decision: "approve"\|"reject", note }` → `AccessRequest` |
| GET | `/api/admin/cache` | → `CacheOverview` |
| PATCH | `/api/admin/cache/sources/:id` | `{ ttlSeconds }` → `CacheOverview` |
| POST | `/api/admin/cache/clear` | `{ sourceId? }` → `CacheOverview` |
| GET | `/api/admin/metrics?range=7d\|30d` | → `UsageMetrics` |

Step-up (`401 step_up_required`) is required for creating, updating and deleting sources and for re-enabling a
disabled one (disabling is always allowed), and will be for changing roles. `Session.recentAuthUntil` says until
when such changes are allowed; the wizard asks for a fresh sign-in up front if less than 20 minutes remain, so
nothing typed into it is lost to a redirect.

The server never trusts the wizard's own test: **create and update re-test the connection** (it must be read-only)
and **re-discover the schema**, then check every exposed table and column really exists and take column types
from the database. If only descriptions or access change while the database is unreachable, the last discovered
schema is used and the source is marked `offline`. Discovery is refused for accounts that aren't read-only.
Connection settings are checked against a per-type allow-list (unknown keys are rejected), TLS is mandatory, and
in production sources on loopback/link-local addresses are refused.

### Audit (`canAudit`)
| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/audit?q&user&sourceId&action&outcome&range&queryId&page&pageSize` | → `Page<AuditEntry>` |
| POST | `/api/audit/export` | `AuditFilters` → `text/csv` (the export itself is audited) |
