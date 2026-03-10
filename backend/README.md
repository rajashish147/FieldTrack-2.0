# FieldTrack 2.0 — Backend

Production-ready Fastify + TypeScript backend for FieldTrack 2.0 SaaS platform.

## Tech Stack

- **Runtime**: Node.js 24+
- **Language**: TypeScript 5.9 (strict mode, ESM)
- **Framework**: Fastify 5
- **Auth**: @fastify/jwt (Supabase JWT)
- **Database**: PostgreSQL via Supabase
- **Job Queue**: BullMQ + Redis
- **Validation**: Zod 4 (`fastify-type-provider-zod`)
- **Observability**: OpenTelemetry 2.x, Prometheus, Grafana
- **Security**: @fastify/helmet, @fastify/cors, @fastify/rate-limit, @fastify/compress

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment template and fill in values
cp .env.example .env

# Start development server
npm run dev
```

## Scripts

| Command         | Description                        |
| --------------- | ---------------------------------- |
| `npm run dev`   | Start dev server with hot reload   |
| `npm run build` | Compile TypeScript to `dist/`      |
| `npm start`     | Run compiled production server     |
| `npm test`      | Run test suite with Vitest         |

## Deployment

### Production Deployment

```bash
# Deploy specific version (automated via CI)
./scripts/deploy-bluegreen.sh a4f91c2

# Rollback to previous version
./scripts/rollback.sh

# Deploy specific historical version
./scripts/deploy-bluegreen.sh 7b3e9f1
```

See [Rollback System Documentation](../docs/ROLLBACK_SYSTEM.md) for detailed deployment and rollback procedures.

## Project Structure

```
src/
├── server.ts          # Entry point
├── app.ts             # Fastify app factory
├── tracing.ts         # OpenTelemetry tracing setup
├── config/            # Environment & logger config
├── plugins/           # Fastify plugins
│   ├── zod.plugin.ts  # Shared Zod compiler registration (single source of truth)
│   ├── openapi.plugin.ts  # Swagger / OpenAPI documentation
│   ├── jwt.ts         # JWT plugin
│   ├── prometheus.ts  # Prometheus metrics
│   └── security/      # helmet, cors, rate-limit, abuse-logging
├── routes/            # Route modules
├── middleware/        # Auth & request middleware
├── modules/           # Business domain modules
│   ├── attendance/
│   ├── expenses/
│   ├── locations/
│   └── session_summary/
├── workers/           # BullMQ background job workers
├── types/             # TypeScript type definitions
└── utils/             # Shared utilities
```

## Docker

```bash
# Build image
docker build -t fieldtrack-backend .

# Run container
docker run -p 3000:3000 --env-file .env fieldtrack-backend
```

## API Endpoints

| Method | Path      | Description          | Auth     |
| ------ | --------- | -------------------- | -------- |
| GET    | `/health` | Health check         | None     |

See [API Reference](../docs/API_REFERENCE.md) for the complete endpoint list.

## Environment Variables

| Variable                   | Description                 | Required |
| -------------------------- | --------------------------- | -------- |
| `PORT`                     | Server port (default: 3000) | No       |
| `NODE_ENV`                 | Environment mode            | No       |
| `SUPABASE_URL`             | Supabase project URL        | Yes      |
| `SUPABASE_SERVICE_ROLE_KEY`| Supabase service role key   | Yes      |
| `SUPABASE_JWT_SECRET`      | JWT signing secret          | Yes      |
| `REDIS_HOST`               | Redis host for BullMQ       | Yes      |
| `REDIS_PORT`               | Redis port (default: 6379)  | No       |
| `TEMPO_ENDPOINT`           | Tempo OTLP endpoint         | No       |

See `.env.example` for a complete list of environment variables.

## Documentation

Detailed documentation is available in the [`/docs`](../docs) directory:

- [API Reference](../docs/API_REFERENCE.md) — all endpoints, auth requirements, request/response schemas
- [Architecture](../docs/ARCHITECTURE.md) — system design, request lifecycle, tenant isolation, key decisions
- [Walkthrough](../docs/walkthrough.md) — phase-by-phase development history and technical deep-dives
- [Rollback System](../docs/ROLLBACK_SYSTEM.md) — deployment tracking and rollback architecture
- [Rollback Quick Reference](../docs/ROLLBACK_QUICKREF.md) — fast command reference for deployment and rollback

See [CHANGELOG.md](../CHANGELOG.md) at the repo root for a full project history.
