# Codebase Audit and Upgrade Recommendations

Date: March 16, 2026

## Scope

This document reviews the non-infra codebase:

- `apps/api/`
- `apps/web/`
- `packages/types/`
- `supabase/migrations/`
- test coverage and developer ergonomics

This is intentionally complementary to `docs/INFRA_CICD_AUDIT_2026-03-16.md`, which covers VPS, monitoring, and CI/CD.

## Executive Summary

The codebase is strongest in the backend core:

- the API is modular and mostly cleanly layered
- performance work has already happened in the right places
- analytics and snapshot tables show good product/ops thinking
- the shared types package reduces a lot of contract drift

The biggest improvement opportunities are now in four areas:

1. scaling the last few endpoints and UI flows that still load or aggregate too much in memory
2. making the frontend catch up with the backend in testing, authorization, and operational maturity
3. reducing type and contract duplication across API, frontend, and Supabase
4. expanding the product from a solid tracking core into a fuller workforce operations platform

## What Is Already Good

### Backend architecture

The backend structure under `apps/api/src/` is easy to reason about:

- routes are thin
- controllers are mostly small
- repositories encapsulate database access
- workers are separated from request handlers
- tenant scoping is centralized through `orgTable()`

This is a strong base for continued feature growth.

### Performance direction

The repo shows good evidence of performance maturity:

- snapshot tables are used for admin session and dashboard reads
- analytics are pre-aggregated into daily metrics
- Redis caching is used intentionally rather than as decoration
- background jobs are idempotent and instrumented
- load tests exist and reflect real endpoints

This is exactly the right direction for a field operations product.

### Shared contract thinking

The shared types package in `packages/types/src/index.ts` is a good move:

- frontend and backend are aligned on DTOs
- API shapes are readable
- contract drift is lower than in many monorepos at this stage

## Key Improvement Areas

### 1. Finish the move from raw-table scans to true read models

The backend has already introduced strong read models:

- `employee_latest_sessions`
- `employee_daily_metrics`
- `org_daily_metrics`
- `org_dashboard_snapshot`

But some endpoints still fall back to raw scans and in-memory aggregation:

- `apps/api/src/modules/analytics/analytics.repository.ts:44-47` and `73-77` cap analytics session reads at `5000`
- `apps/api/src/modules/analytics/analytics.repository.ts:215-235` still reads session rows for top performers
- `apps/api/src/modules/dashboard/dashboard.service.ts:42-49` computes employee dashboard values by scanning sessions and expenses directly
- `apps/api/src/modules/profile/profile.repository.ts:61-80` computes lifetime stats from `attendance_sessions` on every request

Why this matters:

- the architecture is halfway between "live query" and "read model"
- the remaining raw scans will become the next bottleneck as org size grows
- the codebase already has the right data model to avoid them

Recommendation:

- move employee dashboard/profile summaries onto pre-aggregated tables too
- add a dedicated employee profile snapshot if profile pages become frequent
- remove the `limit(5000)` ceiling from analytics by replacing those queries with DB-side aggregation or additional snapshot tables

### 2. Use the backend aggregations the frontend already has

The frontend still leaves performance on the table in a few places.

The clearest example:

- `apps/web/src/hooks/queries/useDashboard.ts:15-24` defines `useAdminDashboard()`
- but `apps/web/src/app/(protected)/dashboard/page.tsx:7-11` still composes the admin dashboard from multiple hooks
- the live activity feed adds manual invalidation polling in `apps/web/src/app/(protected)/dashboard/page.tsx:411-423`

Another example:

- `apps/web/src/hooks/queries/useExpenses.ts:43-70` fetches all org expenses across pages
- `apps/web/src/app/(protected)/admin/expenses/page.tsx:275-277` groups them client-side
- even though the repo already exposes `API.expensesSummary`

Why this matters:

- your backend has already done the expensive optimization work
- the frontend is not consistently consuming the optimized surfaces
- browser memory and client-side grouping will age poorly with larger orgs

Recommendation:

- refactor admin dashboard pages to use `useAdminDashboard()` as the primary source
- replace `useAllOrgExpenses()` in admin review flows with paginated server-side grouping and drill-down
- reserve client-side aggregation for small, explicitly bounded datasets

### 3. Tighten authorization and routing on the frontend

The backend is strict about roles, but the frontend is lighter:

- `apps/web/src/middleware.ts:6-13` only enforces authenticated session presence
- admin pages like `apps/web/src/app/(protected)/admin/monitoring/page.tsx:35-39` redirect unauthorized users in `useEffect`

Why this matters:

- unauthorized users can still hit admin routes client-side and then get bounced
- the UX relies on client permissions after render
- role protection is correct at the API layer, but the app shell can feel inconsistent

Recommendation:

- add role-aware route protection at the Next.js middleware or layout level
- prefer server-side gating for admin sections
- keep API checks as the source of truth, but make the frontend experience align with them

### 4. Reduce type-system escape hatches and manual duplication

The codebase has good shared types, but there is still duplication:

- `apps/api/src/db/query.ts:50-56` casts the Supabase client through `any`
- `packages/types/src/index.ts` is type-only and does not provide runtime validation
- OpenAPI exists, but response schemas are only declared on a subset of routes

Why this matters:

- backend DB access loses a lot of compile-time safety exactly where schema drift hurts most
- frontend and backend share interfaces, but not runtime-validated contracts
- API docs are present, but not yet fully leveraged for generated clients or contract tests

Recommendation:

- generate and use a typed Supabase `Database` client everywhere possible
- move toward shared Zod schemas or generated client types from OpenAPI
- expand route response schemas until OpenAPI is complete enough to generate a frontend SDK

High-value end state:

- one contract source
- typed DB access
- generated client helpers
- fewer hand-maintained DTO mappings

### 5. Simplify request-time auth context resolution

The auth middleware is well-defended but still somewhat expensive:

- `apps/api/src/middleware/auth.ts:96-121` resolves organization and employee identity via DB queries, then caches the result

This is already improved by caching, but the longer-term upgrade path is clear:

- store stable org and role claims in JWT custom claims
- decide whether employee id should also be present as a safe claim
- reduce request-time DB lookups further

This is especially valuable if the API becomes more interactive or more real-time.

### 6. Standardize time and timezone semantics

There are currently multiple time models in play:

- `apps/api/src/modules/dashboard/dashboard.service.ts:6-15` computes week start in UTC
- `apps/api/src/modules/admin/dashboard.routes.ts:58-62` computes "today" from UTC dates
- `apps/web/src/lib/dateRange.ts:7-8` explicitly computes ranges in the browser's local timezone

Why this matters:

- "today", "this week", and "recent" can feel inconsistent depending on which page a user is on
- field-workforce products are especially sensitive to date boundaries, local time, and attendance windows

Recommendation:

- define one system-wide timezone policy for analytics and dashboards
- document whether reports are org-local, user-local, or UTC
- centralize date-range construction rules instead of letting each layer define its own meaning

### 7. Bring frontend quality up to backend quality

The backend has meaningful unit and integration coverage under `apps/api/tests/`.
Repository inspection found no frontend `test/spec` files under `apps/web/`.

Why this matters:

- the product UX is now complex enough that regressions are likely to happen in the UI
- admin dashboard, expense review, auth, and map flows deserve coverage
- the frontend is now the weaker side of the codebase from a confidence perspective

Recommendation:

- add frontend tests for:
  - auth flow and redirects
  - role-based navigation
  - dashboard rendering and loading/error states
  - expense review actions
  - map page behavior with empty/loading/error data
- add at least one browser-level smoke test flow for login -> dashboard -> expense -> logout

### 8. Clean up version and documentation drift inside the app layer too

There is still product-facing and developer-facing version drift:

- `apps/web/README.md:3-9` says Next.js 15 and Tailwind 4
- `apps/web/package.json` currently uses `next: ^14.2.20`
- `README.md:40` still advertises Node.js 20
- `apps/api/package.json:6-8` requires Node `>=24.0.0`

Recommendation:

- align package versions and docs
- publish one source-of-truth compatibility matrix for:
  - Node version
  - Next version
  - frontend build/deploy expectations
  - local development prerequisites

## Product and Feature Suggestions

These are not generic ideas. They fit the system you already have.

### 1. Employee lifecycle and admin management

Current state:

- backend supports `POST /admin/employees`
- `apps/api/src/modules/employees/employees.routes.ts` only exposes creation
- creation requires manual `employee_code` and optional `user_id`
- frontend has no visible employee-management creation flow

Upgrade suggestion:

- add a proper employee directory
- support invite-by-email flows
- auto-generate employee codes server-side
- allow activate/deactivate, team assignment, and manager assignment

Why this is high-value:

- it closes a real operational gap
- it makes onboarding manageable without touching Supabase manually
- it sets up future role and org structure improvements

### 2. Expand the role model beyond `ADMIN` and `EMPLOYEE`

Current state:

- `packages/types/src/index.ts:17` defines only `"ADMIN" | "EMPLOYEE"`

Upgrade suggestion:

- introduce supervisor/team-lead/finance roles
- scope views and approvals by team or region
- separate analytics visibility from expense approval rights

Why it matters:

- most real field organizations are not flat
- a richer role model unlocks better delegation without granting full admin power

### 3. Expense workflows: storage, policy, and finance readiness

Current state:

- expense submission accepts `receipt_url`
- `apps/api/src/modules/expenses/expenses.schema.ts:20-23` validates URL only
- `apps/web/src/app/(protected)/expenses/page.tsx` asks users to paste a receipt URL

Upgrade suggestion:

- add receipt upload to Supabase Storage
- add expense categories and policy rules
- add rejection reason/comment fields
- add export to CSV/XLSX
- add OCR or AI-assisted receipt extraction later

Why it matters:

- this turns expense tracking from a demo-friendly feature into an actually useful finance workflow

### 4. Real-time operations surface

Current state:

- admin map and feed refresh by polling every 30 seconds
- the backend already has enough operational data to power richer live views

Upgrade suggestion:

- add SSE or WebSocket updates for:
  - live employee map markers
  - session check-in/check-out stream
  - queue health and failed-job notifications

Why it matters:

- the product domain is inherently live
- polling works now, but real-time delivery would make the app feel much more operationally serious

### 5. Queue and background-job operations UI

Current state:

- backend has `/admin/queues`
- there is dead-letter queue logic for analytics jobs
- repository inspection found no frontend queue operations page

Upgrade suggestion:

- add an admin operations page for:
  - queue depths
  - failed jobs
  - replaying dead-letter jobs
  - triggering analytics backfill
  - viewing worker health

Why it matters:

- this is a natural next step now that workers are central to correctness
- it reduces SSH-and-log dependence during incidents

### 6. Map and route intelligence

Current state:

- you already have live markers and session route rendering

Upgrade suggestion:

- add playback of a session route over time
- add stop clustering and gap detection
- add geofence / out-of-area alerts
- surface suspicious behavior:
  - impossible travel
  - missing check-out
  - long inactive sessions
  - location silence during active sessions

Why it matters:

- the data model already supports much of this
- these are natural differentiators for a field tracking platform

### 7. Reporting and scheduled summaries

Current state:

- analytics are visible interactively, but operational reporting is still mostly dashboard-driven

Upgrade suggestion:

- scheduled daily/weekly admin summaries
- email or Slack reports
- CSV exports for payroll, attendance, expenses, and leaderboard periods
- manager-specific filtered reports

This is especially valuable once staging and alerting are stronger.

## Engineering Roadmap

### Immediate

- replace client-side all-expense loading with server-side grouped expense views
- use `/admin/dashboard` in the actual admin dashboard UI
- add frontend tests and frontend CI
- standardize timezone semantics
- align package/docs version claims

### Next 1-2 weeks

- typed Supabase `Database` integration
- fuller OpenAPI response coverage
- generated frontend client or shared runtime schemas
- role-aware frontend route protection
- employee management UI and basic invite flow

### Next 1-2 months

- queue operations UI
- real-time transport for live views
- receipt upload and structured expense categories
- richer role model
- employee/profile/dashboard snapshots to eliminate remaining raw scans

## Highest-Value Single Improvements

If you only pick a few things next, I would prioritize these:

1. Replace the frontend's heaviest client-side data assembly with the optimized backend endpoints that already exist.
2. Add frontend test coverage and a frontend CI workflow.
3. Add employee lifecycle management as a real feature, not just a backend endpoint.
4. Build an operations page for queues, failed jobs, and analytics replay.
5. Move toward typed DB access plus generated/shared runtime contracts.

## Bottom Line

The codebase is not in a "needs rewrite" place at all.

It is in a good "second-system shaping" place:

- the core backend is credible
- the performance direction is good
- the product surface is useful
- the next gains come from finishing the transitions already started

Those transitions are:

- from raw scans to read models
- from client assembly to server aggregation
- from interface-only types to stronger generated/shared contracts
- from backend-only maturity to full-stack maturity
- from feature set to product system
