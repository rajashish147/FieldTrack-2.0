# FieldTrack API — Environment Variable Contract

> **Single source of truth for all environment variables across every layer of the system.**
>
> When in doubt about a variable's name, type, or where it belongs — read this document first.

---

## Layer Model

```
┌──────────────────────────────────────────────────────────────────┐
│  LAYER          │  KEY VARIABLES               │  SCOPE          │
├──────────────────────────────────────────────────────────────────┤
│  Backend (API)  │  API_BASE_URL                │  EXTERNAL URL   │
│                 │  APP_BASE_URL                │  EXTERNAL URL   │
│                 │  FRONTEND_BASE_URL           │  EXTERNAL URL   │
│                 │  PORT, CORS_ORIGIN, …        │  INTERNAL       │
├──────────────────────────────────────────────────────────────────┤
│  CI / Scripts   │  API_BASE_URL                │  EXTERNAL URL   │
│                 │  CORS_ORIGIN                 │  DEPLOY CONFIG  │
├──────────────────────────────────────────────────────────────────┤
│  Infra          │  API_HOSTNAME                │  DOMAIN ONLY    │
│                 │  METRICS_SCRAPE_TOKEN        │  SECURITY       │
│                 │  GRAFANA_ADMIN_PASSWORD      │  SECURITY       │
└──────────────────────────────────────────────────────────────────┘
```

---

## Naming Rules

| Pattern | Meaning | Example |
|---------|---------|---------|
| `*_BASE_URL` | Full URL — scheme + host, **no trailing slash** | `https://api.getfieldtrack.app` |
| `*_HOSTNAME` | Bare domain — **no scheme, no path** | `api.getfieldtrack.app` |

**`API_HOSTNAME` is always DERIVED from `API_BASE_URL` at deploy-time by `load-env.sh`.**  
It must **never** be set in `.env` — set it only in `infra/.env.monitoring`.

---

## Backend

Validated by `src/config/env.ts` (Zod schema, fail-fast).

### URLs

| Variable | Required in Prod | Type | Purpose |
|----------|:---:|------|---------|
| `API_BASE_URL` | ✅ | `https://…` URL | **The canonical public URL of this API.** Used in OpenAPI server definitions and any server-generated links referencing the API itself. Also used by all deploy scripts and CI smoke tests. |
| `APP_BASE_URL` | ✅ | `https://…` URL | Canonical root URL for the whole application. Used in email footers, OpenGraph canonical tags, and generic redirects that don't need to distinguish API vs frontend. |
| `FRONTEND_BASE_URL` | ✅ | `https://…` URL | Public URL of the web frontend (maintained in a separate repository: `fieldtrack-tech/web`). Used to build password-reset and invitation email links. |

#### `FRONTEND_BASE_URL` — Usage Contract

`FRONTEND_BASE_URL` is the **single canonical variable** for the frontend URL. There are no aliases.

**Used for:**
- Password-reset email links: `${FRONTEND_BASE_URL}/reset-password?token=…`
- Invitation email links: `${FRONTEND_BASE_URL}/accept-invite?token=…`
- User-facing redirects that land the user in the web UI

**NOT used for:**
- CORS allowed-origin configuration (use `CORS_ORIGIN`)
- API routing or reverse-proxy targets
- Internal service-to-service calls

**Validation rules (enforced at startup by Zod):**
- Must be a valid absolute URL (`http://` or `https://`)
- Must **not** end with a trailing slash — trailing slashes are stripped automatically and asserted by schema refine
- Optional outside production; **required in production** — startup fails if absent when `APP_ENV=production`
- No fallback — if the value is missing in production, the process exits with a clear error

### Runtime

| Variable | Required | Default | Purpose |
|----------|:---:|---------|---------|
| `CONFIG_VERSION` | ✅ | `"1"` | Schema version guard — must be `"1"`. Bumped when the env schema has a breaking change. |
| `APP_ENV` | ✅ | `development` | Canonical application environment. Drive ALL app-level logic from this. Falls back to `NODE_ENV`. |
| `NODE_ENV` | — | `development` | Kept for npm/Node ecosystem compatibility only. **Never use for app logic.** |
| `PORT` | ✅ | `3000` | Internal container listen port (1000–65535). |

### Auth & Data

| Variable | Required | Purpose |
|----------|:---:|---------|
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_ANON_KEY` | ✅ | Supabase public/anon key (safe for browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role key — bypasses RLS. **Never expose to clients.** |
| `SUPABASE_JWT_SECRET` | ✅ | JWT signing secret (≥ 32 chars, HS256). Used by `@fastify/jwt` in tests. |
| `REDIS_URL` | ✅ | Redis connection URL (`redis://` or `rediss://`) |

### Security & Observability

| Variable | Required in Prod | Default | Purpose |
|----------|:---:|---------|---------|
| `CORS_ORIGIN` | ✅ | `""` (dev fallback) | Comma-separated allowed CORS origins. Empty in dev activates safe localhost fallback. Must be explicit in production. |
| `METRICS_SCRAPE_TOKEN` | ✅ | — | Bearer token Prometheus must present to scrape `/metrics`. Unset = open in dev/test. **Must** be set in production. |
| `TEMPO_ENDPOINT` | — | `http://tempo:4318` | OTLP HTTP endpoint for Grafana Tempo traces. |
| `SERVICE_NAME` | — | `fieldtrack-api` | OpenTelemetry service name label. |
| `GITHUB_SHA` | — | `"manual"` | Git commit SHA. Auto-injected by GitHub Actions. |

### Limits

| Variable | Default | Purpose |
|----------|---------|---------|
| `BODY_LIMIT_BYTES` | `1000000` | Max request body size (bytes). DDoS protection. |
| `REQUEST_TIMEOUT_MS` | `30000` | Fastify connection timeout (ms). |
| `MAX_QUEUE_DEPTH` | `1000` | Max BullMQ queue depth before new enqueues are rejected. |
| `MAX_POINTS_PER_SESSION` | `50000` | Max GPS points per session for recalculation jobs. |
| `MAX_SESSION_DURATION_HOURS` | `168` | Sessions older than this (hours) are skipped as anomalies. |
| `WORKER_CONCURRENCY` | `1` | Distance worker job concurrency per replica. |
| `ANALYTICS_WORKER_CONCURRENCY` | `5` | Analytics worker job concurrency (1–50). |

### CI-only Flags (not in Zod schema)

| Variable | Purpose |
|----------|---------|
| `WORKERS_ENABLED` | Set to `"false"` in CI/test to disable BullMQ workers (Redis not required). Default `"true"` in production. |
| `CI` | Auto-set by GitHub Actions. Used for logging only. |

---

## CI / Scripts — GitHub Actions + Shell Scripts

Variables consumed by `smoke-test.sh`, deploy scripts, and workflows.  
Stored as **GitHub repository secrets**.

| Secret Name | Purpose | Used By |
|------------|---------|---------|
| `API_BASE_URL` | Full public URL of the API for health probes and smoke tests | `deploy.yml`, `smoke-test.sh` |
| `CORS_ORIGIN` | Allowed CORS origins for the deployed container | `deploy.yml` (pre-flight validation) |
| `DO_HOST` | DigitalOcean VPS IP / hostname | SSH deploy steps |
| `DO_USER` | SSH username on VPS | SSH deploy steps |
| `DO_SSH_KEY` | SSH private key (PEM) | SSH deploy steps |
| `FT_EMP_EMAIL` | Employee test account email | `smoke-test.sh` |
| `FT_EMP_PASSWORD` | Employee test account password | `smoke-test.sh` |
| `FT_ADMIN_EMAIL` | Admin test account email | `smoke-test.sh` |
| `FT_ADMIN_PASSWORD` | Admin test account password | `smoke-test.sh` |
| `SUPABASE_URL` | Supabase project URL (for smoke test auth) | `smoke-test.sh` |
| `SUPABASE_ANON_KEY` | Supabase anon key (for smoke test auth) | `smoke-test.sh` |

> **Renamed:** `FT_API_BASE_URL` → `API_BASE_URL`. Update the GitHub repo secret accordingly.

---

## Infra — `infra/.env.monitoring`

Used by Docker Compose for Prometheus, Grafana, Nginx, Blackbox Exporter.

| Variable | Required | Purpose |
|----------|:---:|---------|
| `API_HOSTNAME` | ✅ | Bare domain for Prometheus scrape target and Grafana root URL. **Always derived from `API_BASE_URL`** — set explicitly here to match. Example: `api.getfieldtrack.app` |

| `GRAFANA_ADMIN_PASSWORD` | ✅ | Grafana admin account password (min 12 chars). |
| `METRICS_SCRAPE_TOKEN` | ✅ | **Must be identical to `METRICS_SCRAPE_TOKEN` in `.env`.** Bearer token for `/metrics` scraping. |
| `ALERTMANAGER_SLACK_WEBHOOK` | ✅ | Slack incoming webhook URL for alert delivery. |

---

## Environment Examples

### Development (`.env.local` / `.env`)

```bash
# Backend .env
CONFIG_VERSION=1
APP_ENV=development
NODE_ENV=development
PORT=3001
APP_BASE_URL=http://localhost:3001
API_BASE_URL=http://localhost:3001
FRONTEND_BASE_URL=http://localhost:3000
CORS_ORIGIN=http://localhost:3000
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_JWT_SECRET=at-least-32-chars-long-for-hs256-dev
REDIS_URL=redis://localhost:6379
```

### Staging

```bash
# Backend
APP_ENV=staging
API_BASE_URL=https://api.staging.getfieldtrack.app
APP_BASE_URL=https://staging.getfieldtrack.app
FRONTEND_BASE_URL=https://app.staging.getfieldtrack.app
CORS_ORIGIN=https://app.staging.getfieldtrack.app

# Infra
API_HOSTNAME=api.staging.getfieldtrack.app
```

### Production

```bash
# Backend
APP_ENV=production
NODE_ENV=production
API_BASE_URL=https://api.getfieldtrack.app
APP_BASE_URL=https://getfieldtrack.app
FRONTEND_BASE_URL=https://app.getfieldtrack.app
CORS_ORIGIN=https://app.getfieldtrack.app
METRICS_SCRAPE_TOKEN=<openssl rand -hex 32>

# Infra (infra/.env.monitoring on VPS)
API_HOSTNAME=api.getfieldtrack.app
METRICS_SCRAPE_TOKEN=<same token as backend>
GRAFANA_ADMIN_PASSWORD=<strong password>

# GitHub Secrets (repo settings → Secrets and variables → Actions)
API_BASE_URL=https://api.getfieldtrack.app
CORS_ORIGIN=https://app.getfieldtrack.app
DO_HOST=<vps-ip>
DO_USER=ashish
DO_SSH_KEY=<pem private key>
FT_EMP_EMAIL=<smoke test employee>
FT_EMP_PASSWORD=<smoke test employee password>
FT_ADMIN_EMAIL=<smoke test admin>
FT_ADMIN_PASSWORD=<smoke test admin password>
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...
```

---

## Internal vs External Distinction

| Variable | Internal / External | Notes |
|----------|-------------------|-------|
| `PORT` | INTERNAL | Container-to-container port. Never exposed directly. |
| `REDIS_URL` | INTERNAL | Container network DNS (`redis://redis:6379`). |
| `TEMPO_ENDPOINT` | INTERNAL | Container network DNS (`http://tempo:4318`). |
| `SUPABASE_URL` | EXTERNAL | Supabase managed service. |
| `API_BASE_URL` | EXTERNAL | Public internet URL. |
| `APP_BASE_URL` | EXTERNAL | Public internet URL. |
| `FRONTEND_BASE_URL` | EXTERNAL | Public internet URL. Points to the web frontend (fieldtrack-tech/web). |
| `API_HOSTNAME` | INFRA-INTERNAL | Used for Nginx/Prometheus config, derived from `API_BASE_URL`. |

---

## Migration Notes

The following variables were **renamed** as part of the env contract cleanup (March 2026):

| Old Name | New Name | Where |
|----------|----------|-------|
| `FT_API_BASE_URL` | `API_BASE_URL` | GitHub secrets, `smoke-test.sh`, `deploy.yml` |

**Action required:**
1. Rename the GitHub repository secret `FT_API_BASE_URL` → `API_BASE_URL`
