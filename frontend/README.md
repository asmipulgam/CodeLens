# CodeLens — frontend

CodeLens lets non-technical employees ask questions about company data in plain English and get
answers in seconds, without waiting for an engineer. It routes each question to the right
database (PostgreSQL, MySQL, SQL Server, Oracle, Snowflake, MongoDB, Redis), runs a safe
read-only query, and explains the result. Repeated questions are answered from a cache.

This folder is the React frontend. It ships with a **mock backend** so every screen works today;
point it at the real API when that exists.

## Quick start

Requires Node.js 20.19+.

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173, using demo data
```

On the sign-in page, pick a demo role:

| Role | What to try |
|---|---|
| **Business user** | Ask “What were total sales by region last month?”, then ask it again (answered from the cache). Try “Which orders are delayed in shipping?” (MongoDB, hidden emails), “How many people are using the app right now?” (Redis), “What is our headcount by department?” (access denied → request access), “Show unpaid invoices from 2023” (offline source), “Delete all cancelled orders” (blocked). |
| **Analyst** | “Revenue by region” (asks you to clarify gross vs net), “List all transactions from the partner channel” (cost warning, then 500 of 1.2M rows), “Show monthly revenue for this year compared with last year” (line chart). Analysts see the generated SQL, can pick data sources and export CSV. |
| **Admin** | Everything above, plus *Admin*: add a data source (try username `admin` to see the read-only check fail, or host `fail.example` to see a connection error), manage roles, approve access requests, tune the cache, view usage. |
| **Auditor** | The audit log: filter, expand entries, export. |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with the mock backend |
| `npm run build` | Type-check and build for production (no mock code is included) |
| `npm run build:demo` | Static build that runs entirely on demo data |
| `npm run preview` | Serve the last build locally |
| `npm test` | Unit + end-to-end tests (Vitest, Testing Library, MSW) |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm run audit:prod` | `npm audit` for runtime dependencies |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VITE_USE_MOCKS` | `true` in dev, `false` in production | Use the in-browser mock backend |
| `VITE_API_PROXY_TARGET` | `http://localhost:8000` | Where `npm run dev` proxies `/api` when mocks are off |

Put overrides in `.env.local`. **Never put secrets in `VITE_*` variables** — they are compiled into the public bundle.

To develop against the real backend (see `../backend/README.md`): `npm run dev:api`.

## How it's organised

```
src/
  api/          types.ts (the API contract), fetch client, streaming reader, endpoints
  app/          providers, router, layout, theme
  auth/         sign-in page, session guard, idle timeout, cross-tab sign-out
  components/   shared UI (Radix-based) and chart building blocks
  features/
    ask/        the main question-and-answer workspace
    results/    table, MongoDB document, Redis and chart views
    catalog/    “What can I ask?”
    settings/   personal preferences
    admin/      data sources (+ 6-step wizard), users & roles, access requests, cache, usage
    audit/      audit log
  mocks/        demo backend (dev/demo builds only)
docs/api-contract.md   every endpoint and the backend's security obligations
deploy/                example nginx config with security headers
```

## Security model

The browser is never trusted to enforce anything — the backend checks every request
(see [`docs/api-contract.md`](docs/api-contract.md)). The frontend's job is to never leak data:

- **No tokens in the browser.** Sign-in is SSO through the backend; the browser holds only an
  `HttpOnly` session cookie. The CSRF token lives in memory and goes on every write.
- **Nothing sensitive is stored.** No results, questions or tokens in localStorage, sessionStorage
  or IndexedDB (only the theme preference). API responses are `no-store`.
- **Sign-out wipes memory**, aborts any answer still streaming, and signs out every open tab.
- **Idle timeout** with a 2-minute warning; expired sessions return to sign-in.
- **Database content is untrusted.** It is rendered as text only; `dangerouslySetInnerHTML` is
  banned by lint. CSV/clipboard exports neutralise spreadsheet formulas.
- **Open-redirect protection** on the post-login `returnTo` parameter.
- **Write-only credentials** in the data-source wizard; a connection can only be saved after a
  test proves the account is read-only. Fields that look personal are pre-marked as hidden.
- **Production builds** contain no mock code, no source maps and no `console` calls from app
  code. No third-party CDNs, fonts or analytics.
- **Headers:** strict CSP (`script-src 'self'`), HSTS, `frame-ancestors 'none'` — see `deploy/`.
- Dependencies are pinned exactly (`.npmrc save-exact`) and audit clean at the time of writing.

## Accessibility

Keyboard reachable throughout, visible focus, skip link, labelled controls, live regions for
answer progress, `aria-sort` on tables, colour never used alone (status = icon + label), every
chart has a table view, light/dark themes, reduced-motion support. Colour palette validated for
colour-blind safety in both themes.

## Defaults chosen (change any of these)

- **Identity provider:** any OIDC provider (Keycloak, Microsoft Entra ID, Okta). The frontend only
  calls `/api/auth/*`, so the choice lives in the backend.
- **Roles:** Business user, Analyst, Admin, Auditor. Only Analyst/Admin see generated queries;
  only Analyst/Admin can export.
- **Users:** employees only; clients never sign in.
- **Database types:** all seven in the wizard.
- **Look:** neutral light/dark theme following the system, with a cyan accent.
- **Devices:** desktop-first, works on tablets and phones.
