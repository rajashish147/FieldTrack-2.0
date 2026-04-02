# Changelog

All significant changes to FieldTrack 2.0 are documented here by development phase.

---

## [Post-Phase-20] — Reliability Audit, Node 24 Upgrade & OTel 2.x — 2026

### Zod Compiler Reliability Fix
- Created `src/plugins/zod.plugin.ts` — single exported `registerZod(app)` helper that calls `setValidatorCompiler` + `setSerializerCompiler`; this is now the **only** place these are set, eliminating the previous drift between production and test environments
- Updated `src/app.ts` to call `registerZod(app)` at the root level **before** any plugins or routes are registered
- Removed the duplicate `setValidatorCompiler` / `setSerializerCompiler` calls that were previously inside `openapi.plugin.ts`
- Updated `tests/setup/test-server.ts` to call `registerZod(app)` from the shared plugin instead of inline copies

### Fastify Lifecycle Fix — auth before validation
- Moved `[authenticate, requireRole(...)]` from `preHandler` to `preValidation` on all routes that carry a Zod `body` or `querystring` schema
  - `POST /expenses`, `PATCH /admin/expenses/:id`, `GET /expenses/my`, `GET /admin/expenses`
  - `GET /attendance/my-sessions`, `GET /attendance/org-sessions`
  - `POST /locations`, `POST /locations/batch`, `GET /locations/my-route`
  - All three analytics admin endpoints
- This ensures `401 Unauthorized` / `403 Forbidden` always fires first, before Zod ever runs, matching the expected HTTP semantics

### Error Handler — 4xx passthrough
- Updated `setErrorHandler` in both `src/app.ts` and `tests/setup/test-server.ts` to pass through Fastify's built-in `4xx` errors (validation errors, rate-limit 429, etc.) instead of collapsing them to 500

### Location Route Schemas
- Added missing `body: createLocationSchema` to `POST /locations`
- Added missing `body: createLocationBatchSchema` to `POST /locations/batch`
- Added missing `querystring: sessionQuerySchema` to `GET /locations/my-route`
- These schemas were previously only applied inside the controller; moving them to the route definition makes them visible to OpenAPI/Swagger generation

### BullMQ Job Retention
- Added `removeOnComplete: { count: 1000 }` and `removeOnFail: { count: 5000 }` to the distance worker constructor
- Prevents unbounded Redis memory growth from accumulating stale job records

### Node.js 24 Upgrade
- Bumped `Dockerfile` from `node:20-alpine` → `node:24-alpine` (both builder and production stages)
- Added `"engines": { "node": ">=24.0.0" }` to `package.json`

### OpenTelemetry 2.x Upgrade
- Upgraded `@opentelemetry/auto-instrumentations-node`: `^0.55.0` → `^0.71.0`
- Upgraded `@opentelemetry/exporter-trace-otlp-http`: `^0.57.0` → `^0.213.0`
- Upgraded `@opentelemetry/sdk-node`: `^0.57.0` → `^0.213.0`
- Added `@opentelemetry/resources@^2.0.0` and `@opentelemetry/sdk-trace-base@^2.0.0` as explicit dependencies (previously transitive)
- Updated `src/tracing.ts`: replaced `new Resource({ ... })` (class, removed in v2) with `resourceFromAttributes({ ... })` factory; replaced deprecated `SEMRESATTRS_*` constants (removed in `semantic-conventions@1.40`) with stable string literals (`"service.name"`, `"service.version"`, `"deployment.environment"`)

### Test Suite
- Test count increased from 124 → **125** passing tests
- All existing integration and unit tests continue to pass after the lifecycle and compiler changes

---

## [Post-Phase-18] — CI/CD Upgrade & Multi-Version Rollback — 2026

### CI/CD Pipeline (commits `b61cc19`, `29cb948`)
- Split GitHub Actions `deploy.yml` into two jobs: `test` (runs on all events) and `build-and-deploy` (push to master only, `needs: test`)
- Replaced `npm install` with `npm ci` for deterministic dependency installs
- Added `npx tsc --noEmit` type-check step before tests in CI
- Added `actions/setup-node` cache keyed on `package-lock.json` to avoid redundant installs
- Upgraded Docker build to `docker/build-push-action` with GitHub Actions layer cache (`type=gha`)
- PRs to `master` now run the `test` job — failing tests block merge
- Every image is tagged with both `latest` and a 7-character SHA

### Rollback System (commits `35db851`, `23e7720`)
- Added `backend/scripts/rollback.sh` — reads `.deploy_history`, validates ≥ 2 deployments, displays history table with current/target markers, prompts for confirmation, redeploys previous image using `deploy-bluegreen.sh`
- Updated `backend/scripts/deploy-bluegreen.sh` to prepend the deployed SHA to `.deploy_history` (rolling window of 5) after every successful deploy
- Added `backend/.gitignore` entry for `.deploy_history`
- Added `docs/ROLLBACK_SYSTEM.md` and `docs/ROLLBACK_QUICKREF.md`

---

## [Phase 18] — Automated Test Suite & Production Hardening — 2026

### Test Infrastructure
- Added Vitest and `@vitest/coverage-v8` to devDependencies
- Added `vitest.config.ts` (globals, node env, `setupFiles`)
- Added `tsconfig.test.json` extending base config with `vitest/globals` types
- Added `tests/setup/env-setup.ts` — sets all required env vars from test env
- Added `tests/setup/test-server.ts` — minimal `buildTestApp()` factory with JWT plugin + routes (no Redis, no Prometheus, no BullMQ)
- Added `tests/helpers/uuid.ts` — `TEST_UUID()`, `TEST_UUIDS(n)`, `FIXED_TEST_UUID` helpers (needed for Zod 4 strict UUID validation)

### Test Coverage (8 files, 124 tests)
- `tests/unit/utils/pagination.test.ts` — `applyPagination()` clamping, offsets, coercion
- `tests/unit/utils/response.test.ts` — `ok()`, `fail()`, `handleError()` dispatch
- `tests/unit/utils/errors.test.ts` — all custom error classes and inheritance
- `tests/unit/services/attendance.service.test.ts` — `checkIn`/`checkOut` business rules
- `tests/unit/services/expenses.service.test.ts` — `createExpense`/`updateExpenseStatus` role enforcement
- `tests/integration/attendance/attendance.test.ts` — check-in, check-out, my-sessions, org-sessions (401/403/400/201/200)
- `tests/integration/expenses/expenses.test.ts` — full CRUD flow including re-review guard
- `tests/integration/locations/locations.test.ts` — single insert, batch insert, my-route

### Production Hardening
- `src/utils/tenant.ts` — added `TenantContext` type; `enforceTenant()` now accepts both `FastifyRequest` and a plain `TenantContext` object (enables worker-path usage without a fake request)
- `src/middleware/role-guard.ts` — `requireRole()` now throws `ForbiddenError` instead of manually calling `reply.status(403).send()`, routing all auth failures through the centralized `handleError` pipeline
- `src/routes/debug.ts` — early return in `production` environment, preventing infrastructure disclosure
- `src/config/env.ts` — added `WORKER_CONCURRENCY` env var (default `1`)
- `src/modules/locations/locations.schema.ts` — documented `sequence_number` nullable design decision with planned migration SQL

---

## [Phase 17] — API & Service Layer Hardening — 2026

- Added `applyPagination()` utility (`src/utils/pagination.ts`) — centralised page/limit clamping with safe defaults; used by all list endpoints
- Added `ok()` / `fail()` / `handleError()` response helpers (`src/utils/response.ts`) — standardised JSON response shape across all controllers
- Migrated all controllers to use `handleError` pipeline eliminating scattered `try/catch` blocks
- All list endpoints now return consistent `{ success: true, data: [...] }` shape
- Introduced `AppError` hierarchy in `src/utils/errors.ts` — `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `BadRequestError` and domain errors (`EmployeeAlreadyCheckedIn`, `SessionAlreadyClosed`, `ExpenseAlreadyReviewed`)

---

## [Phase 16] — Schema Migration, Enum Types & Repository Typing — 2026

- Added `backend/migrations/phase16_schema.sql` and Supabase migration `20260309000000_phase16_schema.sql`
- Added PostgreSQL enum types for `attendance_status` and `expense_status`
- Added TypeScript DB type definitions (`src/types/db.ts`) generated from the Supabase schema snapshot
- Updated all repositories to use typed Supabase query responses
- Locked repository return types throughout — no more `any` casts on DB results
- `sequence_number` column added to `gps_locations` (nullable, pending mobile stabilization)

---

## [Phase 15] — API Security & Rate Limiting Overhaul — 2026

- Extracted security concerns into dedicated plugins under `src/plugins/security/`
  - `helmet.plugin.ts` — `@fastify/helmet` with CSP deferred pending frontend enumeration
  - `cors.plugin.ts` — `@fastify/cors` with `ALLOWED_ORIGINS` env and `credentials: true`
  - `ratelimit.plugin.ts` — Redis-backed global 100 req/min, `127.0.0.1`/`::1` allowlisted
  - `abuse-logging.plugin.ts` — structured 429 logging; brute-force detection on auth routes
- Added two new Prometheus counters: `security_rate_limit_hits_total{route}`, `security_auth_bruteforce_total{ip}`
- Rate-limit Redis connection is separate from the BullMQ Redis connection

---

## [Phase 14] — Distributed Tracing, Log Correlation & Metric Exemplars — 2026

- Added `src/tracing.ts` — OpenTelemetry Node.js SDK with OTLP HTTP exporter to Tempo; `fs` instrumentation disabled to reduce noise; must be the first import in `server.ts`
- Added `otelMixin` in `src/config/logger.ts` — injects `trace_id`, `span_id`, `trace_flags` into every Pino log line
- Added OTel span enrichment in `app.ts` `onRequest` hook — sets `http.route`, `http.client_ip`, `request.id`, `enduser.id` on every request
- Upgraded Prometheus histogram to `observeWithExemplar()` with `traceId` on every observation
- Updated `infra/docker-compose.monitoring.yml` — Tempo ports 4317/4318; Prometheus `--enable-feature=exemplar-storage`
- Updated `infra/prometheus/prometheus.yml` — OpenMetrics scrape format for exemplar ingestion

---

## [Phase 13] — Production Infrastructure: VPS, Nginx & Monitoring Stack — 2026

- Added `backend/scripts/vps-setup.sh` — idempotent VPS provisioning (Docker, Nginx, systemd, certbot, ufw)
- Added `infra/nginx/api.conf` — TLS termination, HTTP→HTTPS redirect, proxy headers, WebSocket upgrade, gzip
- Added `infra/docker-compose.monitoring.yml` — Prometheus, Grafana, Loki, Promtail, Tempo on `api_network`
- Added `infra/grafana/dashboards/fieldtrack.json` — pre-built dashboard (HTTP rate, latency, queue depth, heap, Redis)
- Added `infra/grafana/provisioning/` — auto-provisioned dashboard and Prometheus datasource
- Added `infra/prometheus/alerts.yml` — alert rules for API latency, queue depth, Redis connectivity, host metrics
- Added `infra/promtail/promtail.yml` — Docker log discovery and shipping to Loki

---

## [Phase 12] — Prometheus Metrics, Route Labeling & Metric Fixes — 2025

- Added `src/plugins/prometheus.ts` — `prom-client` registry, `http_request_duration_seconds` histogram, `http_requests_total` counter, `bullmq_queue_depth` gauge
- Added `GET /metrics` endpoint (OpenMetrics text format)
- Iteratively fixed route labeling: stable pattern-based labels (`/users/:id`) instead of raw URLs
- Moved timing hook from `onSend` to `onResponse` for accurate end-to-end latency measurement
- Wrapped plugin with `fastify-plugin` to escape encapsulation

---

## [Phase 11] — CI/CD Deployment Hardening — 2025

- Added initial GitHub Actions workflow for automated deployment
- Added `backend/scripts/deploy-bluegreen.sh` — blue-green zero-downtime deployment using Docker port-swap and Nginx upstream switch
- Health-check validation before traffic switch
- Old container removed only after successful switchover

---

## [Phase 10] — Production Hardening & Enterprise Correctness — 2025

- Added `ALLOWED_ORIGINS` env var and CORS configuration
- Added `bodyLimit: 1_000_000` (1 MB), `connectionTimeout: 5_000`, `keepAliveTimeout: 72_000` to Fastify
- Added `requestIdHeader: "x-request-id"` + `genReqId: () => randomUUID()` for request correlation
- Added `x-request-id` header to every response via `onSend` hook
- Moved from in-process rate limiting to `@fastify/rate-limit` plugin (in-process; later upgraded to Redis-backed in Phase 15)
- Added Redis URL validation — throws on missing scheme instead of silently falling back
- Added `MAX_QUEUE_DEPTH`, `MAX_POINTS_PER_SESSION`, `MAX_SESSION_DURATION_HOURS` safety limits

---

## [Phase 9] — Admin Analytics Layer — 2025

- Added `src/modules/analytics/` module (controller, service, repository, schema, routes)
- Endpoints: `GET /admin/org-summary`, `GET /admin/user-summary`, `GET /admin/top-performers`
- Date range filtering with `from`/`to` ISO-8601 params
- All endpoints ADMIN-only; no analytics data exposed to EMPLOYEE role
- `top-performers` supports `metric` = `distance` | `duration` | `sessions`, `limit` 1–50

---

## [Phase 8] — Expense Module & Architecture Cleanup — 2025

- Added `src/modules/expenses/` module (controller, service, repository, schema, routes)
- Expense lifecycle: `PENDING → APPROVED | REJECTED`; only PENDING expenses can be transitioned
- Added `ExpenseAlreadyReviewed` domain error
- Protected `/internal/metrics` with `authenticate + requireRole("ADMIN")` — previously unauthenticated
- Added `GET /internal/metrics` endpoint returning queue depth, recalculation count, and latency averages

---

## [Phase 7.5] — Crash Recovery, Metrics Registry & Worker Hardening — 2025

- Added `src/utils/metrics.ts` — in-process counters for `totalRecalculations`, `totalLocationsInserted`, `avgRecalculationMs` (rolling average of last 100 jobs)
- Worker now recovers stale jobs on restart — jobs that were `active` when the process crashed are retried automatically
- Added concurrency and backoff configuration to the distance worker
- Added job deduplication in the queue — prevents duplicate recalculation jobs for the same session

---

## [Phase 7] — Asynchronous Background Workers — 2025

- Added `src/workers/distance.queue.ts` — BullMQ queue (`distance-calculation`) with Redis backend
- Added `src/workers/distance.worker.ts` — processes jobs: fetches GPS points → Haversine calculation → upserts `session_summaries`
- `POST /attendance/check-out` now enqueues a BullMQ job instead of calculating synchronously (eliminates HTTP timeout risk on long sessions)
- Added `src/modules/session_summary/` module — service and repository for reading/writing `session_summaries` table
- Added `POST /attendance/:sessionId/recalculate` route for manual re-triggering

---

## [Phase 6] — Distance Engine & Session Summary — 2025

- Added `src/utils/distance.ts` — Haversine formula implementation (`calculateDistance`, `haversine`)
- Added `session_summaries` table to schema (stores `total_distance_km`, `total_duration_seconds` per session)
- Distance calculated synchronously on check-out (later moved to async queue in Phase 7)
- Added `session_summary` service and repository

---

## [Phase 5] — Per-User Rate Limiting & Ingestion Telemetry — 2025

- Added JWT-sub-based `keyGenerator` to `POST /locations` and `POST /locations/batch` — rate limits are per identity, not per IP
- Added `performance.now()` latency tracking in the locations service; logged as `latencyMs` on every insert
- Added `duplicatesSuppressed` metric in batch insert — logs the difference between submitted and actually-inserted points

---

## [Phase 4] — Location Bulk Ingestion — 2025

- Added `POST /locations/batch` endpoint accepting up to 100 GPS points per request
- Added `createLocationBatchSchema` — shared point schema reused from single-insert, `session_id` hoisted to root
- Batch insert uses Supabase `upsert` with `ignoreDuplicates: true` to handle mobile client retries safely

---

## [Phase 3] — Location Ingestion System — 2025

- Added `src/modules/locations/` module (controller, service, repository, schema, routes)
- `POST /locations` — single GPS point ingestion with Zod validation (coordinate bounds, accuracy ≥ 0, `recorded_at` not more than 2 min in future)
- `GET /locations/my-route` — returns all GPS points for a session, ordered by `recorded_at` ASC
- `gps_locations` table uses composite upsert key `(session_id, recorded_at)` for idempotency

---

## [Phase 2] — Attendance Module — 2025

- Added `src/modules/attendance/` module (controller, service, repository, schema, routes)
- `POST /attendance/check-in` — creates `ACTIVE` session; throws `EmployeeAlreadyCheckedIn` if one exists
- `POST /attendance/check-out` — closes `ACTIVE` session; throws `SessionAlreadyClosed` if none exists
- `GET /attendance/my-sessions` — paginated list of own sessions
- `GET /attendance/org-sessions` — ADMIN-only paginated list of all org sessions
- Tenant isolation enforced in every repository query via `organization_id`

---

## [Phase 1] — Secure Tenant Isolation Layer — 2025

- Added `src/middleware/auth.ts` — JWT verification via `@fastify/jwt` + Zod payload validation; attaches `request.organizationId`
- Added `src/middleware/role-guard.ts` — `requireRole(role)` preHandler factory; throws `ForbiddenError` for mismatched roles
- Added `src/types/jwt.ts` + `jwtPayloadSchema` — strict Zod schema for JWT claims (`sub`, `organization_id`, `role`)
- Added `src/utils/tenant.ts` — `enforceTenant()` for ensuring repository queries are always scoped to the authenticated organization
- Added `src/plugins/jwt.ts` — registers `@fastify/jwt` with `SUPABASE_JWT_SECRET`

---

## [Phase 0] — Project Scaffolding — 2025

- Initialized Node.js + TypeScript 5.9 project (strict mode, ESM `"module": "NodeNext"`)
- Added Fastify 5 with `fastify-plugin`
- Added Supabase client (`@supabase/supabase-js`) configured in `src/config/supabase.ts`
- Added Pino structured logging with environment-aware config (`src/config/logger.ts`)
- Added `src/config/env.ts` — centralized environment variable loading with fail-fast validation
- Added `src/config/redis.ts` — ioredis client for BullMQ
- Added `backend/Dockerfile` — multi-stage build (build → production Alpine image)
- Added `.env.example` with all required variable names
