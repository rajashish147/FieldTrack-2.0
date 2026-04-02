# FieldTrack 2.0

> Production-grade multi-tenant backend for real-time field workforce tracking — attendance, GPS, expense management, and admin analytics.

[![CI](https://github.com/fieldtrack-tech/api/actions/workflows/deploy.yml/badge.svg)](https://github.com/fieldtrack-tech/api/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org)

---

## Overview

FieldTrack 2.0 is a production-ready REST API backend for managing field workforce operations. It provides secure, multi-tenant APIs for tracking employee attendance, real-time GPS location, expense workflows, and aggregate analytics — all with a full observability stack, automated CI/CD, and zero-downtime blue-green deployments.

---

## Features

- **Multi-tenant isolation** — every data query is scoped to the authenticated organization; cross-tenant access is architecturally impossible
- **Attendance sessions** — check-in / check-out lifecycle with state machine enforcement (`EmployeeAlreadyCheckedIn`, `SessionAlreadyClosed`)
- **Real-time GPS ingestion** — single and batch endpoints (up to 100 points), idempotent upsert, per-user rate limiting
- **Async distance calculation** — BullMQ background worker computes Haversine distance after check-out; never blocks the HTTP response
- **Expense workflow** — PENDING → APPROVED / REJECTED lifecycle, ADMIN review endpoints, re-review guard
- **Admin analytics** — org-wide summaries, per-user breakdowns, configurable leaderboard (distance / duration / sessions)
- **Redis-backed rate limiting** — per-JWT-sub limits on write endpoints survive corporate NAT and horizontal scaling
- **Security plugins** — Helmet, CORS, Redis rate limiter, brute-force detection with Prometheus counters
- **Distributed tracing** — OpenTelemetry → Tempo; trace IDs injected into every Pino log line
- **One-click metric-to-trace** — Prometheus exemplars link latency spikes directly to Tempo traces in Grafana
- **Blue-green zero-downtime deployments** — Nginx upstream swap, health-check gate, 5-SHA rollback history
- **Automated rollback** — `rollback.sh` restores the previous version in under 10 seconds
- **Full test suite** — 124 tests (8 files) with Vitest; unit + integration coverage; CI blocks deploy on failure

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Runtime** | Node.js 24 (Alpine) |
| **Language** | TypeScript 5.9 (strict, ESM) |
| **Framework** | Fastify 5 |
| **Database** | PostgreSQL via [Supabase](https://supabase.com) |
| **Auth** | JWT (`@fastify/jwt`) — Supabase-issued tokens |
| **Job Queue** | [BullMQ](https://docs.bullmq.io/) + Redis |
| **Validation** | [Zod 4](https://zod.dev/) |
| **Observability** | Prometheus · Grafana · Loki · Tempo · Promtail · OpenTelemetry |
| **Security** | `@fastify/helmet` · `@fastify/cors` · `@fastify/rate-limit` · `@fastify/compress` |
| **Testing** | [Vitest](https://vitest.dev/) |
| **CI/CD** | GitHub Actions → GHCR → Blue-Green VPS Deploy |

---

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                             │
│  Mobile App  →  Web Dashboard  →  Desktop Client                │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS / REST API
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    APPLICATION LAYER                            │
│                                                                  │
│  Nginx (TLS · Blue-Green Routing)                               │
│    │                                                             │
│    ▼                                                             │
│  Fastify 5 API Server                                           │
│    ├─ Auth Middleware (JWT)                                     │
│    ├─ Security (Helmet · CORS · Rate Limit)                     │
│    ├─ Validation (Zod)                                          │
│    └─ Business Logic                                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
                ┌────────────┼────────────┐
                │            │            │
                ▼            ▼            ▼
┌──────────────────┐  ┌──────────────┐  ┌──────────────────┐
│   Supabase       │  │    Redis     │  │  BullMQ Worker   │
│   PostgreSQL     │  │  Job Queue   │  │  (Distance Calc) │
│  (Multi-tenant)  │  │              │  │                  │
└──────────────────┘  └──────────────┘  └──────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                   OBSERVABILITY LAYER                           │
│                                                                  │
│  Prometheus → Grafana ← Loki ← Tempo                            │
│   (Metrics)   (Dashboards) (Logs) (Traces)                      │
└─────────────────────────────────────────────────────────────────┘
```

**📊 For detailed architecture diagrams, data flows, and deployment topology see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

---

## Quick Start

**Prerequisites:** Node.js ≥ 24, npm, Redis, a Supabase project

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — fill in Supabase URL, keys, Redis URL, and ALLOWED_ORIGINS

# 3. Run in development mode
npm run dev

# 4. Run the test suite
npm run test
```

---

## Deployment

FieldTrack 2.0 deploys automatically via GitHub Actions on every push to `master`.

```
Push to master
  → test job (npm ci · tsc · vitest)  — blocks on failure
  → build-and-deploy job (Docker Buildx with GHA cache → GHCR → VPS SSH)
```

### Manual deploy / rollback

```bash
# On the VPS
./scripts/deploy-bluegreen.sh <sha>   # Deploy a specific image
./scripts/rollback.sh                 # Restore previous version (~10 s)
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for full setup instructions including VPS provisioning, Nginx config, and CI/CD secret configuration.

---

## Project Structure

> **Note:** The web frontend is maintained in a separate repository: [fieldtrack-tech/web](https://github.com/fieldtrack-tech/web)

```
api/
├── src/               # Application source
│   ├── modules/       # Domain modules (attendance · locations · expenses · analytics)
│   ├── plugins/       # Fastify plugins (JWT · Prometheus · security stack)
│   ├── workers/       # BullMQ distance calculation worker
│   ├── middleware/    # Auth + role guard
│   └── utils/         # Shared utilities (errors · response · tenant · metrics)
├── tests/             # Vitest unit and integration tests
├── scripts/           # Blue-green deploy + rollback scripts
├── infra/             # Monitoring stack (Prometheus · Grafana · Loki · Tempo)
├── docs/              # Project documentation
└── .github/workflows/ # GitHub Actions CI/CD
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/ARCHITECTURE.md) | System design, component diagrams, data flows, deployment topology, security layers |
| [API Reference](docs/API_REFERENCE.md) | All endpoints, auth requirements, request/response schemas, error codes |
| [Deployment Guide](docs/DEPLOYMENT.md) | VPS provisioning, CI/CD setup, blue-green deploy, troubleshooting |
| [Rollback System](docs/ROLLBACK_SYSTEM.md) | Rollback architecture, deployment history, safety features |
| [Rollback Quick Reference](docs/ROLLBACK_QUICKREF.md) | Fast operator reference card for deployments |
| [Walkthrough](docs/walkthrough.md) | Phase-by-phase build history and deep-dives |
| [Changelog](CHANGELOG.md) | Full history of every phase |
| [Contributing](CONTRIBUTING.md) | Contribution workflow, branching, code conventions |
| [Security Policy](SECURITY.md) | How to report vulnerabilities |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, branch naming conventions, and commit format.

**Branch naming:**
```
feature/<description>   # new functionality
fix/<description>       # bug fixes
infra/<description>     # infrastructure changes
docs/<description>      # documentation
test/<description>      # test additions
chore/<description>     # maintenance / deps
```

**Commit format:**
```
type(scope): short imperative description
```
Allowed types: `feat` `fix` `refactor` `ci` `infra` `docs` `test` `chore`

All PRs require review from CODEOWNERS and must pass CI before merge.

---

## License

[MIT](LICENSE) © 2026 FieldTrack
