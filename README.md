# CodeLens

Ask company data questions in plain English. CodeLens lets non-technical employees query the
company's connected databases (SQL, Snowflake, MongoDB, Redis and more) without waiting for an
engineer. Answers come from safe, read-only queries; repeated questions are served from a
LangChain-backed cache; and every action is audited.

| Part | Status |
|---|---|
| [`frontend/`](frontend/) | Built: React + TypeScript app with a mock backend. See [frontend/README.md](frontend/README.md). |
| [`backend/`](backend/) | Phases 1–3 of 6 done: sign-in, permissions, audit log; data sources (PostgreSQL, MySQL); asking questions with checked, read-only SQL, caching and history. See [backend/README.md](backend/README.md). |

## Decisions

- **AI model:** runs through the company's own **Microsoft Azure** subscription (Azure OpenAI / AI Foundry),
  using a managed identity and a private endpoint. Questions and table structures stay under the company's
  existing Azure agreement.
- **Sign-in:** any OpenID Connect provider. Local development uses Keycloak; switching to the company
  provider is configuration only.
