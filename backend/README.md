# CodeLens — backend

The API behind the CodeLens frontend: sign-in, permissions, and (in later phases) turning questions into
safe read-only database queries. It implements [`../frontend/docs/api-contract.md`](../frontend/docs/api-contract.md).

Python 3.12 · FastAPI · SQLAlchemy 2 + Alembic (PostgreSQL) · Redis · OpenID Connect · LangChain + Azure OpenAI (phase 3)

## Status

| Phase | What | Status |
|---|---|---|
| 1 | Foundation: config, errors, app database, sign-in (OIDC + PKCE), sessions, CSRF, audit log | **Done** |
| 2 | Data sources: admin wizard endpoints, Azure Key Vault, read-only connection test, schema discovery, catalog | **Done** (PostgreSQL + MySQL) |
| 3 | Asking: streaming pipeline, query validation, masking, Azure OpenAI (LangChain), caches, conversations, export | **Done** |
| + | MCP server: AI assistants (Claude, Copilot, Cursor) ask questions through CodeLens | **Done** |
| 4 | MongoDB, Redis, Snowflake (cost confirmation), SQL Server, Oracle | Next |
| 5 | Admin users/roles, access requests, cache page, usage metrics, audit log & export | |
| 6 | Rate limits everywhere, security test suite, Docker image, Azure deployment notes | |

Not built yet (phase 5): access requests, user/role editing, the admin cache and usage pages, and the audit
log pages — those endpoints return `404`.
Testing a SQL Server, Oracle, Snowflake, MongoDB or Redis connection reports that support is coming (phase 4).

## Run it locally

Needs [uv](https://docs.astral.sh/uv/) and Docker.

```bash
cd backend
cp .env.example .env
# set CODELENS_LOCAL_SECRETS_KEY in .env (the command to generate one is next to it)
docker compose up -d --wait          # app Postgres (5433), Redis, Keycloak (8080), sample DBs — localhost only
uv run alembic upgrade head          # create the tables
uv run uvicorn --factory app.main:create_app --port 8000 --reload
```

Then start the frontend against it (in another terminal):

```bash
cd frontend
npm run dev:api                      # http://localhost:5173, proxies /api to localhost:8000
```

If port 8000 is busy, run uvicorn with `--port 8765` and start the frontend with
`VITE_API_PROXY_TARGET=http://localhost:8765 npm run dev:api`.

Open http://localhost:5173. With `CODELENS_DEV_AUTO_LOGIN=true` in `.env` you go straight to the home page as
**Local Developer** (roles from `CODELENS_DEV_AUTO_LOGIN_ROLES`, admin by default) — no sign-in page. This is for
development only: production refuses to start with it on. Set it to `false` (and restart) to sign in with a demo
account instead (password `codelens-dev` for all):

| Username | Keycloak group | CodeLens role |
|---|---|---|
| `priya` | codelens-business | Business user |
| `marcus` | codelens-analysts | Analyst |
| `dana` | codelens-admins | Admin |
| `sam` | codelens-auditors | Auditor |
| `alex` | marketing | none — sign-in is refused with "no access" |

Keycloak's admin console is at http://localhost:8080 (admin / admin). All of this is development-only.

### Sample databases to connect

Sign in as `dana`, open **Admin → Data sources → Add**, and use one of these (TLS option: *Require encryption* —
the samples use self-signed certificates, so the verifying options correctly fail):

| | PostgreSQL | MySQL |
|---|---|---|
| Host / port | `localhost` / `5434` | `localhost` / `3307` |
| Database | `company` (schema `sales`; `hr` is hidden from the reader) | `sales` |
| Read-only account (accepted) | `codelens_reader` / `reader-dev` | `codelens_reader` / `reader-dev` |
| Writable account (refused) | `codelens_writer` / `writer-dev` | `codelens_writer` / `writer-dev`, or `codelens_role_user` / `role-dev` (writes via a role) |

## Commands

| Command | What it does |
|---|---|
| `uv run pytest` | Tests (SQLite + in-memory Redis + a fake sign-in provider that signs real tokens). Connector tests run against the sample databases when they're up, and are skipped otherwise |
| `uv run ruff check . && uv run ruff format --check .` | Lint and formatting |
| `uv run mypy app` | Type check (strict) |
| `uv run alembic revision --autogenerate -m "…"` | New migration after changing `app/models.py` |
| `uv export --no-dev --no-hashes --format requirements-txt > /tmp/req.txt && uv run pip-audit -r /tmp/req.txt` | Vulnerability audit of runtime dependencies |

Dependencies are locked with hashes in `uv.lock`.

## Configuration

All settings are environment variables prefixed `CODELENS_` (see [`.env.example`](.env.example) and
[`app/config.py`](app/config.py)). With `CODELENS_ENVIRONMENT=production` the app **refuses to start**
unless the public URL and identity provider use https, cookies are `Secure`, and the client secret is
not the development value.

### Sign in with Google (approved addresses only)

Besides the company sign-in, CodeLens can offer **Sign in with Google** for a short list of specific Google
accounts (for example contractors or personal Gmail addresses). Anyone not on the list is refused and the
attempt is audited. Rules:

- Each address is listed with its roles: `CODELENS_GOOGLE_USERS={"someone@gmail.com":["business"]}`.
  Matching ignores upper/lower case, and Google must have verified the address.
- **Google accounts can never be admins** — not through the list (the app refuses to start) and not by a later
  manual role change (the admin role is ignored for Google sessions). Google can't be made to force a fresh
  login with MFA, which admin changes require, so admins use the company sign-in.
- The button only appears when a client id, secret and at least one address are set.

To set it up:

1. In [Google Cloud Console](https://console.cloud.google.com/) → *APIs & Services* → *OAuth consent screen*,
   create an **External** app and leave it in **Testing**, adding the approved addresses as *test users*
   (a second allow-list, enforced by Google).
2. *Credentials* → *Create credentials* → *OAuth client ID* → **Web application**, with authorised redirect URI
   `http://localhost:5173/api/auth/callback` (and `https://<codelens-host>/api/auth/callback` in production).
3. Put the client id and secret in `CODELENS_GOOGLE_CLIENT_ID` / `CODELENS_GOOGLE_CLIENT_SECRET` and list the
   addresses in `CODELENS_GOOGLE_USERS`. Restart the backend.

### Switching to the company's sign-in provider

Register CodeLens as a *confidential web app* with:

- redirect URI `https://<codelens-host>/api/auth/callback`
- post-logout redirect URI `https://<codelens-host>/login?reason=signed_out`
- PKCE (S256) allowed, and group membership included in the ID token

then set `CODELENS_OIDC_ISSUER`, `CODELENS_OIDC_CLIENT_ID`, `CODELENS_OIDC_CLIENT_SECRET`,
`CODELENS_OIDC_GROUPS_CLAIM` and `CODELENS_GROUP_ROLE_MAP`. No code changes.

- **Microsoft Entra ID**: issuer `https://login.microsoftonline.com/<tenant-id>/v2.0`. Either emit the `groups`
  claim (values are group object IDs — map those IDs) or define app roles and set the claim to `roles`.
- **Okta**: issuer `https://<org>.okta.com/oauth2/default`; add a `groups` claim to the ID token.

## How sign-in works

1. `GET /api/auth/login` creates a random `state`, `nonce` and PKCE verifier, stores them in Redis for
   10 minutes, ties them to the browser with an `HttpOnly` cookie, and redirects to the identity provider.
2. `GET /api/auth/callback` takes the stored transaction (once only), checks it belongs to this browser,
   exchanges the code (with the PKCE verifier and client secret), and validates the ID token: signature
   against the provider's published keys, issuer, audience/azp, expiry, nonce — and for step-up, that the
   person really re-authenticated.
3. The user's groups are mapped to roles. Nobody in a mapped group (and no default roles) → refused and audited.
4. A new random session id goes in an `HttpOnly; Secure; SameSite=Strict` cookie (`__Host-` prefixed).
   Redis stores only a SHA-256 of it. No access or refresh tokens are kept; nothing token-like reaches the browser.
5. Every API call re-loads the user and roles from the database, so disabling a user or changing a role
   takes effect on their next click. Sessions end after 15 minutes idle or 8 hours, whichever is first.
6. Writes need the `X-CSRF-Token` header (from `GET /api/auth/session`) and, if present, a matching `Origin`.
7. `POST /api/auth/logout` deletes the session and returns the provider's sign-out URL.

Admin changes to data sources need `canAdmin` **and** a sign-in within the last 30 minutes (step-up).

## Data sources

- **Credentials are write-only.** They go to the secret store and are never returned; the API reports only
  `{isSet, updatedAt}`. Production uses **Azure Key Vault** via the backend's managed identity
  (`CODELENS_SECRET_STORE=azure_key_vault`, `CODELENS_KEY_VAULT_URL`); give that identity the *Key Vault Secrets
  Officer* role on the vault (plus purge permission if `CODELENS_KEY_VAULT_PURGE_ON_DELETE=true`). Development
  uses AES-256-GCM encryption in the app database. Secret names use a random per-source id, so they don't reveal
  which database they open.
- **Read-only is proven, not assumed.** PostgreSQL: no superuser/createrole/createdb/replication/bypassrls, no
  INSERT/UPDATE/DELETE/TRUNCATE on any table, no CREATE on any schema. MySQL: every privilege from
  `SHOW GRANTS` — including those through roles — must be SELECT / SHOW VIEW / USAGE. Sessions are also opened
  read-only as a second layer.
- **Encryption is mandatory.** PostgreSQL `verify-full` / `verify-ca` use the operating system's trusted CAs;
  MySQL connections are refused if the server doesn't actually negotiate TLS.
- **The server re-checks everything on save** (see the API contract): connection, read-only, and that exposed
  tables/columns exist.

## Answering questions

```
understanding → routing → (clarify?) → building → (confirm?) → running → summarising → answer
```

1. **Understanding.** Requests to change data ("delete…", "update…") are refused immediately (`write_blocked`).
2. **Routing.** Only enabled sources the person's roles allow (and, for analysts, the ones they picked).
3. **Planning.** The model is given *only* those sources' exposed tables and columns (hidden ones marked),
   descriptions, glossary and example questions — never connection details or data. It replies with one
   SQL query, a clarifying question, or "can't answer". Earlier questions in the conversation are included
   so follow-ups work.
4. **Checking** (`app/pipeline/sql_guard.py`, using sqlglot) — the model's SQL is parsed, not trusted:
   exactly one `SELECT`; no INTO / FOR UPDATE / DDL / DML; no unknown functions (`pg_sleep`, `dblink`,
   `load_file`…); only exposed tables (pinned to their schema) and exposed columns (`*` expands to those only);
   hidden columns are replaced by `NULL` in the output so their values are never even read, and may otherwise
   appear only as `COUNT(column)` — not in filters, grouping, sorting or other functions; a `LIMIT` of the
   source's row limit + 1. A real model gets one retry with the reason if its query is rejected.
5. **Confirming.** `EXPLAIN` estimates the work; above `CODELENS_CONFIRM_ROWS_THRESHOLD` rows the person is
   asked before it runs.
6. **Running** in a read-only transaction on the read-only account, with the source's timeout. Cancel stops
   the database query. Truncated results get a separate `COUNT(*)` for the true total.
7. **Summarising.** With Azure OpenAI and `CODELENS_AI_SHARES_RESULT_ROWS=true`, up to 30 masked rows go to
   the model, marked as data; otherwise a template summary is written and no rows reach the model. A chart is
   added when the shape suits one.

**Caching (two layers, both Redis).** Results are cached per source for the admin's chosen time; the key
includes the source's schema version, the exact SQL and the asker's roles and source access, so cached rows
never cross access boundaries. "Refresh" bypasses it. Model responses are cached with LangChain's cache
interface (`app/llm/cache.py`), keyed on the full prompt — which only contains what that user may see.

**Stored:** conversations (answers are stored *after* masking), the question log, saved questions and feedback.
Generated SQL is removed from responses for roles without `canViewQuery`. Exports enforce `canExport` and the
export row limit, neutralise spreadsheet formulas and add a "Confidential — exported by …" line. Every
question, refusal, cancellation and export is audited, including the SQL that ran.

### AI provider

- **`standin`** (default until Azure is set up): not AI — it matches words to the exposed tables and handles
  counts, totals, averages, top/bottom N (joining through `<table>_id` keys), grouping by a column or by
  day/week/month/quarter/year, and time filters (today, last month, this year, last N days…). It asks which
  table to use when that's unclear. Its SQL passes through the same checks.
- **`azure_openai`**: LangChain `AzureChatOpenAI` with the managed identity (`DefaultAzureCredential`; locally
  `az login`). Give the identity the *Cognitive Services OpenAI User* role on the Azure OpenAI resource, and set
  `CODELENS_AZURE_OPENAI_ENDPOINT` / `_DEPLOYMENT`. Disable public network access on the resource and reach it
  through a private endpoint. Ask legal about Microsoft's abuse-monitoring retention (see the main README).

## MCP server (AI assistants)

AI assistants that speak the [Model Context Protocol](https://modelcontextprotocol.io) — Claude, VS Code
Copilot, Cursor and others — can ask CodeLens questions for a person at **`/api/mcp`** (Streamable HTTP;
stateless, JSON responses, so any server behind a load balancer can answer). Code: `app/mcp_server.py`.

| Tool | What it does |
|---|---|
| `list_data_sources` | The sources this person may use, with example questions |
| `describe_data_source` | Tables, columns (hidden ones marked) and glossary of one source |
| `ask_question` | Plain-English question → summary, result rows, and the SQL if the role may see it |
| `answer_clarification` | Continue a question CodeLens asked to clarify, with the chosen option |
| `confirm_query` | Run a slow query after the person agreed |

**The assistant never touches a database.** Every call runs the same pipeline as the web app: the person's
roles decide which sources they see, every query passes `sql_guard`, hidden columns stay null, the question
rate limit is shared with the web app, and every answer is audited with "via MCP". All tools are read-only
(`readOnlyHint`). At most `CODELENS_MCP_MAX_ROWS` rows go back to the assistant; the answer includes a link to
see the rest in CodeLens, and the conversation shows up in the person's CodeLens history.

**Off by default** (`CODELENS_MCP_ENABLED`): answers go to whichever AI model the employee's assistant uses,
not only the company's Azure OpenAI. Turn it on once the company has approved the assistants, and list their
app ids in `CODELENS_MCP_ALLOWED_CLIENT_IDS` so tokens issued to any other app are refused.

**Sign-in.** CodeLens is an OAuth 2.1 resource server. An assistant that gets `401` reads
`/.well-known/oauth-protected-resource/api/mcp`, signs the person in at the company identity provider
(Authorization Code + PKCE), and sends the access token as `Authorization: Bearer …`. A token is accepted only
if the company provider signed it, it hasn't expired, its `aud` is the MCP endpoint (`CODELENS_MCP_AUDIENCE`
to override; this stops tokens for other apps — including the web sign-in — being replayed), it is an access
token (not an ID or refresh token), and, if configured, it was issued to an approved app. Roles come from the
token's groups exactly as at web sign-in, so moving someone out of a group takes effect on their next call.
Google sign-in doesn't apply here (Google access tokens can't be checked offline); Google-only users use the
web app. Requests must name CodeLens's own host (DNS-rebinding protection).

**Identity provider setup** (production, Entra ID): register an app for the assistants (public client,
PKCE, redirect URIs of the approved assistants), expose an API whose Application ID URI is the MCP URL (or set
`CODELENS_MCP_AUDIENCE` to it), include the groups claim in access tokens, and put its client id in
`CODELENS_MCP_ALLOWED_CLIENT_IDS`. Route `/.well-known/oauth-protected-resource/*` to the backend as well as
`/api/*`. The dev Keycloak realm has this set up as the `codelens-mcp` client (audience mapper + groups); if
your Keycloak was started before it was added, re-import with `docker compose up -d --force-recreate keycloak`
(this resets the dev Keycloak to the realm file).

### Connecting an assistant locally

With `CODELENS_DEV_AUTO_LOGIN=true` (development only) assistants connect without signing in, as Local
Developer. Turn MCP on with `CODELENS_MCP_ENABLED=true`, then:

- **Claude Code:** `claude mcp add --transport http codelens http://localhost:5173/api/mcp`
- **VS Code (Copilot agent mode):** `.vscode/mcp.json` →
  `{"servers": {"codelens": {"type": "http", "url": "http://localhost:5173/api/mcp"}}}`
- **MCP Inspector** (try the tools by hand): `npx @modelcontextprotocol/inspector`, transport
  "Streamable HTTP", URL `http://localhost:5173/api/mcp`

Claude Desktop and claude.ai custom connectors reach servers from the internet, so they need CodeLens deployed
on a public `https://` address (not `localhost`).

## Audit log

`audit_events` is append-only: PostgreSQL triggers reject `UPDATE`, `DELETE` and `TRUNCATE`, and each row
stores a SHA-256 of the previous one, so `AuditLog.verify_chain()` reports the first altered row.
Events are written in their own transaction, so denied actions are recorded even when the request fails.

### Database roles (production)

Run migrations as an owner role, and the app as a separate role with only what it needs:

```sql
CREATE ROLE codelens_app LOGIN PASSWORD '…';
GRANT SELECT, INSERT, UPDATE, DELETE ON users, roles, user_roles, preferences, sources, conversations,
  messages, queries, saved_questions, feedback TO codelens_app;
GRANT USAGE ON SEQUENCE messages_seq_seq TO codelens_app;
GRANT SELECT, INSERT ON audit_events TO codelens_app;
GRANT USAGE ON SEQUENCE audit_events_seq_seq TO codelens_app;
```

## Layout

```
app/
  main.py         app factory, lifespan, middleware
  config.py       settings + production safety checks
  errors.py       {code, message} errors, never stack traces
  middleware.py   security headers, no-store, body size cap, log scrubbing
  db.py, models.py, audit.py
  auth/           oidc.py (the OIDC client), sessions.py (Redis), deps.py (guards), roles.py, return_to.py
  api/            auth.py, me.py, sources.py, admin_sources.py, admin_roles.py, queries.py, conversations.py
  mcp_server.py   MCP server for AI assistants: token checks, tools (reuses api/ and pipeline/)
  pipeline/       engine.py (the question flow), sql_guard.py (query checks), results.py (tables, charts, CSV)
  llm/            base.py, standin.py, azure.py (LangChain + Azure OpenAI), cache.py (LangChain Redis cache)
  sources/        fields.py (allowed settings per type), service.py, connectors/ (postgres, mysql)
  secrets/        store.py (Azure Key Vault, local encrypted store)
migrations/       Alembic (first migration also installs the audit-log triggers)
dev/              Keycloak realm with demo users; sample Postgres/MySQL seed data
tests/
```
