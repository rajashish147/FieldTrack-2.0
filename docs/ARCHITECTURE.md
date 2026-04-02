# FieldTrack 2.0 System Architecture

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          CLIENT LAYER                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐              │
│  │   Mobile     │    │     Web      │    │   Desktop    │              │
│  │     App      │    │   Dashboard  │    │    Client    │              │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘              │
│         │                   │                    │                       │
│         └───────────────────┼────────────────────┘                       │
│                             │                                            │
│                             │ HTTPS / REST API                           │
│                             │                                            │
└─────────────────────────────┼────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       APPLICATION LAYER                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │                    Fastify API Server                          │     │
│  │                    (Node.js + TypeScript)                      │     │
│  ├────────────────────────────────────────────────────────────────┤     │
│  │                                                                 │     │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │     │
│  │  │     Auth     │  │   Business   │  │  Validation  │        │     │
│  │  │  Middleware  │  │    Logic     │  │   (Zod)      │        │     │
│  │  └──────────────┘  └──────────────┘  └──────────────┘        │     │
│  │                                                                 │     │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │     │
│  │  │  Rate Limit  │  │    CORS      │  │   Helmet     │        │     │
│  │  │   Security   │  │   Security   │  │   Security   │        │     │
│  │  └──────────────┘  └──────────────┘  └──────────────┘        │     │
│  │                                                                 │     │
│  └─────────────────────────┬───────────────────────────────────────     │
│                            │                                             │
└────────────────────────────┼─────────────────────────────────────────────┘
                             │
                ┌────────────┼────────────┐
                │            │            │
                ▼            ▼            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         DATA LAYER                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                    Supabase Platform                         │       │
│  ├──────────────────────────────────────────────────────────────┤       │
│  │                                                               │       │
│  │  ┌────────────────────────────────────────────────────┐     │       │
│  │  │          PostgreSQL Database                       │     │       │
│  │  ├────────────────────────────────────────────────────┤     │       │
│  │  │                                                     │     │       │
│  │  │  • organizations                                    │     │       │
│  │  │  • users                                            │     │       │
│  │  │  • employees                                        │     │       │
│  │  │  • attendance_sessions                              │     │       │
│  │  │  • gps_locations                                    │     │       │
│  │  │  • expenses                                         │     │       │
│  │  │                                                     │     │       │
│  │  │  Multi-tenant: Row Level Security (RLS)            │     │       │
│  │  │                                                     │     │       │
│  │  └────────────────────────────────────────────────────┘     │       │
│  │                                                               │       │
│  │  ┌────────────────────────────────────────────────────┐     │       │
│  │  │          Authentication (JWT)                      │     │       │
│  │  └────────────────────────────────────────────────────┘     │       │
│  │                                                               │       │
│  └───────────────────────────────────────────────────────────────       │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                      BACKGROUND JOBS LAYER                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                      Redis (BullMQ)                          │       │
│  │                    Job Queue Manager                         │       │
│  └────────────────────────┬─────────────────────────────────────┘       │
│                           │                                              │
│                           ▼                                              │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                  Distance Worker                             │       │
│  ├──────────────────────────────────────────────────────────────┤       │
│  │                                                               │       │
│  │  • Processes GPS location updates                            │       │
│  │  • Calculates distances between locations                    │       │
│  │  • Updates session travel metrics                            │       │
│  │  • Handles concurrent job processing                         │       │
│  │                                                               │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                    OBSERVABILITY LAYER                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐             │
│  │  Prometheus  │───▶│   Grafana    │◀───│     Loki     │             │
│  │   (Metrics)  │    │ (Dashboard)  │    │    (Logs)    │             │
│  └──────────────┘    └──────────────┘    └──────────────┘             │
│         ▲                                        ▲                       │
│         │                                        │                       │
│         │            ┌──────────────┐            │                       │
│         └────────────│    Tempo     │────────────┘                       │
│                      │  (Traces)    │                                    │
│                      └──────────────┘                                    │
│                             ▲                                            │
│                             │                                            │
│                             │ OpenTelemetry                              │
│                             │                                            │
└─────────────────────────────┼────────────────────────────────────────────┘
                              │
                              │
                    ┌─────────┴─────────┐
                    │                   │
                    │  Fastify API      │
                    │  (Instrumented)   │
                    │                   │
                    └───────────────────┘
```

## Component Details

### Client Layer
- **Mobile App**: Field employee mobile application for attendance and location tracking
- **Web Dashboard**: Admin dashboard for management and analytics
- **Desktop Client**: Desktop application for supervisors and managers

### Application Layer
- **Fastify API Server**: High-performance Node.js REST API
  - JWT authentication via Supabase
  - Multi-tenant isolation with organization context
  - Rate limiting and security middleware
  - Zod schema validation via `fastify-type-provider-zod` (`zod.plugin.ts` is the single registration point)
  - `preValidation` hook for auth — ensures 401/403 always fires before body/querystring schema validation
  - OpenTelemetry instrumentation

### Data Layer
- **Supabase PostgreSQL**: Primary database with Row Level Security
  - Multi-tenant data isolation
  - Real-time subscriptions support
  - Built-in authentication

### Background Jobs Layer
- **Redis + BullMQ**: Distributed job queue
- **Distance Worker**: Asynchronous GPS processing
  - Haversine distance calculations
  - Session travel metrics
  - Configurable concurrency (`WORKER_CONCURRENCY` env var)
  - Job retention limits: 1 000 completed, 5 000 failed (prevents Redis memory growth)

### Observability Layer
- **Prometheus**: Metrics collection and alerting
- **Grafana**: Visualization dashboards
- **Loki**: Log aggregation and querying
- **Tempo**: Distributed tracing
- **OpenTelemetry**: Unified instrumentation

## Data Flow

### Attendance Check-In Flow
```
Mobile App
    │
    │ POST /attendance/check-in
    │ { latitude, longitude }
    │
    ▼
Fastify API
    │
    ├─▶ preValidation: Auth Middleware (verify JWT)   ← runs first
    │
    ├─▶ Validate Request Body (Zod)                  ← runs after auth
    │
    ├─▶ Create Session (Supabase)
    │
    └─▶ Queue Distance Job (BullMQ)
            │
            ▼
        Distance Worker
            │
            ├─▶ Calculate Distance
            │
            └─▶ Update Session (Supabase)
```

### Location Update Flow
```
Mobile App
    │
    │ POST /locations
    │ { session_id, latitude, longitude, accuracy, recorded_at }
    │
    ▼
Fastify API
    │
    ├─▶ preValidation: Auth Middleware        ← runs first
    │
    ├─▶ Validate Body (Zod createLocationSchema)
    │
    ├─▶ Validate Active Session
    │
    ├─▶ Store Location (Supabase)
    │
    └─▶ Queue Distance Job (BullMQ)
            │
            ▼
        Distance Worker
            │
            ├─▶ Get Previous Location
            │
            ├─▶ Calculate Distance
            │
            └─▶ Update Total Distance
```

### Analytics Query Flow
```
Web Dashboard
    │
    │ GET /analytics/summary
    │
    ▼
Fastify API
    │
    ├─▶ Auth Middleware (ADMIN role)
    │
    ├─▶ Validate Date Range
    │
    ├─▶ Query Aggregated Data (Supabase)
    │
    └─▶ Return Metrics
```

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         VPS DEPLOYMENT                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                         Nginx                                │       │
│  │                   (Reverse Proxy)                            │       │
│  │                                                               │       │
│  │  • SSL/TLS Termination                                       │       │
│  │  • Load Balancing                                            │       │
│  │  • Blue-Green Routing                                        │       │
│  │                                                               │       │
│  └────────────────────┬─────────────────────────────────────────┘       │
│                       │                                                  │
│         ┌─────────────┴─────────────┐                                   │
│         │                           │                                   │
│         ▼                           ▼                                   │
│  ┌─────────────┐            ┌─────────────┐                            │
│  │   Blue      │            │   Green     │                            │
│  │ Container   │            │ Container   │                            │
│  │ (Active)    │            │ (Standby)   │                            │
│  │             │            │             │                            │
│  │ Port: 3001  │            │ Port: 3002  │                            │
│  └─────────────┘            └─────────────┘                            │
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                    Docker Network                            │       │
│  │                  (api_network)                        │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                  Monitoring Stack                            │       │
│  │                                                               │       │
│  │  Prometheus | Grafana | Loki | Tempo | Promtail             │       │
│  │                                                               │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘

                              ▲
                              │
                              │ GitHub Actions CI/CD
                              │
┌─────────────────────────────┴─────────────────────────────────────────────┐
│                      CI/CD PIPELINE                                       │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  GitHub Push → Test → Build Docker → Push GHCR → Deploy Blue-Green        │
│                                                                             │
│  • Automated testing (125 tests)                                           │
│  • TypeScript compilation check                                            │
│  • Docker image build with caching                                         │
│  • Push to GitHub Container Registry                                       │
│  • Blue-green deployment with health checks                                │
│  • Rollback capability (last 5 deployments)                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Security Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      SECURITY LAYERS                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Layer 1: Network Security                                               │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │  • HTTPS/TLS encryption                                      │       │
│  │  • Nginx reverse proxy                                       │       │
│  │  • CORS policy enforcement                                   │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                           │
│  Layer 2: Application Security                                           │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │  • Helmet.js security headers                                │       │
│  │  • Rate limiting (per IP/user)                               │       │
│  │  • Request validation (Zod schemas)                          │       │
│  │  • JWT authentication                                        │       │
│  │  • Role-based access control (RBAC)                          │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                           │
│  Layer 3: Data Security                                                  │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │  • Row Level Security (RLS)                                  │       │
│  │  • Multi-tenant isolation                                    │       │
│  │  • Encrypted connections                                     │       │
│  │  • Audit logging                                             │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                           │
│  Layer 4: Monitoring & Response                                          │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │  • Abuse detection logging                                   │       │
│  │  • Prometheus alerting                                       │       │
│  │  • Distributed tracing                                       │       │
│  │  • Error tracking                                            │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

## Technology Stack

### Backend
- **Runtime**: Node.js 24+
- **Language**: TypeScript 5.9 (strict mode, ESM)
- **Framework**: Fastify 5
- **Validation**: Zod 4 (`fastify-type-provider-zod`)
- **Authentication**: @fastify/jwt
- **Job Queue**: BullMQ + Redis

### Database
- **Primary**: PostgreSQL (via Supabase)
- **Cache/Queue**: Redis
- **ORM**: Supabase Client

### Security
- **Headers**: @fastify/helmet
- **CORS**: @fastify/cors
- **Rate Limiting**: @fastify/rate-limit
- **Compression**: @fastify/compress

### Observability
- **Metrics**: Prometheus + prom-client
- **Logs**: Pino + Loki
- **Traces**: OpenTelemetry 2.x + Tempo
- **Dashboards**: Grafana

### DevOps
- **Containerization**: Docker (node:24-alpine)
- **Registry**: GitHub Container Registry (GHCR)
- **CI/CD**: GitHub Actions
- **Deployment**: Blue-Green with rollback
- **Reverse Proxy**: Nginx
- **Testing**: Vitest (125 tests)

## Scalability Considerations

### Horizontal Scaling
- Stateless API design allows multiple instances
- Redis-backed job queue for distributed workers
- Database connection pooling

### Vertical Scaling
- Configurable worker concurrency
- Adjustable rate limits
- Database query optimization

### Performance Optimizations
- Docker layer caching in CI/CD
- npm dependency caching
- Fastify's high-performance routing
- Async/await for non-blocking I/O
- Background job processing for heavy operations

## Related Documentation

- [Deployment Guide](../docs/DEPLOYMENT.md)
- [Rollback System](../docs/ROLLBACK_SYSTEM.md)
- [API Documentation](../README.md)
- [CI/CD Pipeline](../.github/workflows/deploy.yml)
