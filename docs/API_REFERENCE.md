# FieldTrack 2.0 — API Reference

Complete reference for all HTTP endpoints exposed by the backend.

---

## Interactive Documentation

**Phase 19: OpenAPI Integration**

The API now provides interactive documentation via **Swagger UI** and a machine-readable **OpenAPI 3.0 specification**.

### Accessing Documentation

| Resource | URL | Description |
|----------|-----|-------------|
| **Swagger UI** | `/docs` | Interactive API explorer with request/response examples |
| **OpenAPI Spec** | `/openapi.json` | JSON schema for API contract (OpenAPI 3.0) |

### Using Swagger UI

1. Navigate to `http://localhost:4000/docs` (development) or `https://api.fieldtrack.app/docs` (production)
2. Click **Authorize** button in the top right
3. Enter your JWT token in the format: `Bearer <your-jwt-token>`
4. Click **Authorize** to save
5. All subsequent requests will include the authentication header

### Example cURL Command

```bash
curl -X POST http://localhost:4000/attendance/check-in \
  -H "Authorization: Bearer <your-jwt-token>" \
  -H "Content-Type: application/json"
```

### API Tags

Endpoints are organized by the following tags:

- **health** — Health check and system status endpoints
- **attendance** — Attendance tracking and session management
- **locations** — Location tracking and route calculation
- **expenses** — Expense reporting and management
- **analytics** — Business analytics and reporting (ADMIN only)
- **admin** — Administrative operations (ADMIN role required)

---

## Authentication

All endpoints except the public health/metrics routes require a Supabase-issued JWT passed as a Bearer token.

```
Authorization: Bearer <supabase-jwt>
```

The JWT payload must include these claims (validated by Zod on every request):

| Claim | Type | Description |
|-------|------|-------------|
| `sub` | `string` (UUID) | User identity — used as the primary actor identifier |
| `organization_id` | `string` (UUID) | Tenant identifier — enforced on every data query |
| `role` | `"EMPLOYEE"` \| `"ADMIN"` | Determines access to protected endpoints |

---

## Standard Error Response

All error responses share this structure:

```json
{
  "success": false,
  "error": "Human-readable error message",
  "requestId": "uuid-of-this-request"
}
```

Validation errors (`400`) include `details`:

```json
{
  "success": false,
  "error": "Validation failed",
  "details": [{ "path": ["field"], "message": "must be a valid UUID" }],
  "requestId": "..."
}
```

### Common Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Resource created |
| `400` | Validation failure or business rule violation |
| `401` | Missing or invalid JWT |
| `403` | JWT valid but role insufficient |
| `404` | Resource not found |
| `429` | Rate limit exceeded (`{ success: false, error: "Too many requests", retryAfter: "Ns" }`) |
| `500` | Unexpected server error |

---

## Response Headers

Every response includes:

| Header | Value |
|--------|-------|
| `x-request-id` | UUID generated per-request (matches `requestId` in error bodies) |

---

## System Routes

### `GET /health`

Public health check. No authentication required.

**Response `200`:**
```json
{ "status": "ok", "timestamp": "2026-03-10T12:00:00.000Z" }
```

---

### `GET /metrics`

Prometheus scrape endpoint. Returns metrics in OpenMetrics text format.

- No authentication required
- Scraped automatically by Prometheus every 15 s
- Required response format: `Content-Type: application/openmetrics-text` (for exemplar support)

---

### `GET /internal/metrics`

Internal operational snapshot. Requires JWT + **ADMIN** role.

**Response `200`:**
```json
{
  "uptimeSeconds": 3600,
  "queueDepth": 2,
  "totalRecalculations": 1540,
  "totalLocationsInserted": 287430,
  "avgRecalculationMs": 42.7
}
```

| Field | Description |
|-------|-------------|
| `uptimeSeconds` | Seconds since process start |
| `queueDepth` | Sessions currently waiting in the BullMQ worker queue |
| `totalRecalculations` | Cumulative completed distance recalculations since last restart |
| `totalLocationsInserted` | Cumulative GPS points written (after deduplication) since last restart |
| `avgRecalculationMs` | Rolling average recalculation latency (last 100 jobs) |

---

### `GET /debug/redis`

**Development / staging only.** Disabled in production (`NODE_ENV=production` returns 404).

Pings Redis via the BullMQ connection and produces an OTel span (visible in Tempo service graph).

**Response `200`:**
```json
{ "status": "ok", "redis": "PONG" }
```

**Response `503`:**
```json
{ "status": "error", "redis": "unreachable" }
```

---

## Attendance Module

All attendance endpoints require JWT authentication. ADMIN routes additionally require `role: "ADMIN"`.

---

### `POST /attendance/check-in`

Start a new attendance session. Creates a new record with `checked_in_at = now()` and `status = "ACTIVE"`.

**Auth:** Any authenticated user

**Request body:** None

**Response `201`:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "employee_id": "uuid",
    "organization_id": "uuid",
    "checked_in_at": "2026-03-10T08:00:00.000Z",
    "checked_out_at": null,
    "status": "ACTIVE"
  }
}
```

**Error `400`:** `"Cannot check in: you already have an active session. Check out first."` — thrown by `EmployeeAlreadyCheckedIn`

---

### `POST /attendance/check-out`

Close the caller's active session. Sets `checked_out_at = now()`, `status = "CLOSED"`, and enqueues a BullMQ job to recalculate distance and duration.

**Auth:** Any authenticated user

**Request body:** None

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "employee_id": "uuid",
    "organization_id": "uuid",
    "checked_in_at": "2026-03-10T08:00:00.000Z",
    "checked_out_at": "2026-03-10T17:00:00.000Z",
    "status": "CLOSED"
  }
}
```

**Error `400`:** `"Cannot check out: no active session found. Check in first."` — thrown by `SessionAlreadyClosed`

---

### `POST /attendance/:sessionId/recalculate`

Manually trigger an async distance/duration recalculation for a specific session. Useful after data corrections or for debugging.

**Auth:** Any authenticated user  
**Rate limit:** 5 requests per 60 seconds per JWT `sub`

**Path params:**

| Param | Type | Required |
|-------|------|----------|
| `sessionId` | UUID | Yes |

**Request body:** None

**Response `202`:**
```json
{ "success": true, "queued": true }
```

**Error `404`:** Session not found or does not belong to the caller's organization.

---

### `GET /attendance/my-sessions`

List the caller's own attendance sessions, newest first.

**Auth:** Any authenticated user  
**Query params:**

| Param | Type | Default | Constraints |
|-------|------|---------|-------------|
| `page` | integer | `1` | min 1 |
| `limit` | integer | `20` | min 1, max 100 |

**Response `200`:**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "employee_id": "uuid",
      "organization_id": "uuid",
      "checked_in_at": "...",
      "checked_out_at": "...",
      "status": "CLOSED"
    }
  ]
}
```

---

### `GET /attendance/org-sessions`

List all attendance sessions for the caller's organization, newest first. ADMIN only.

**Auth:** JWT + `role: "ADMIN"`  
**Query params:** Same as `/attendance/my-sessions`

**Response `200`:** Same shape as `my-sessions` but includes sessions from all employees in the organization.

---

## Locations Module

High-frequency GPS ingestion. Both write endpoints are rate-limited per JWT `sub` to prevent individual employees from flooding the ingestion pipeline, even when sharing an IP (e.g. corporate NAT).

---

### `POST /locations`

Ingest a single GPS point for an active session.

**Auth:** JWT + `role: "EMPLOYEE"`  
**Rate limit:** 10 requests per 10 seconds per JWT `sub`

**Request body:**
```json
{
  "session_id": "uuid",
  "latitude": 28.6139,
  "longitude": 77.2090,
  "accuracy": 12.5,
  "recorded_at": "2026-03-10T09:30:00.000Z"
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `session_id` | UUID | Must be a valid UUID |
| `latitude` | number | -90 to 90 |
| `longitude` | number | -180 to 180 |
| `accuracy` | number | ≥ 0 (metres) |
| `recorded_at` | ISO-8601 datetime | Must not be more than 2 minutes in the future |

**Response `201`:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "session_id": "uuid",
    "organization_id": "uuid",
    "latitude": 28.6139,
    "longitude": 77.2090,
    "accuracy": 12.5,
    "recorded_at": "2026-03-10T09:30:00.000Z",
    "sequence_number": null
  }
}
```

> **Note:** `sequence_number` is nullable during mobile app stabilization. Distance calculations use `ORDER BY recorded_at` as the primary ordering.

---

### `POST /locations/batch`

Ingest up to 100 GPS points in a single request. Duplicate points (same `session_id` + `recorded_at`) are silently ignored (upsert with `ignoreDuplicates: true`).

**Auth:** JWT + `role: "EMPLOYEE"`  
**Rate limit:** 10 requests per 10 seconds per JWT `sub`

**Request body:**
```json
{
  "session_id": "uuid",
  "points": [
    { "latitude": 28.6139, "longitude": 77.2090, "accuracy": 12.5, "recorded_at": "2026-03-10T09:30:00.000Z" },
    { "latitude": 28.6142, "longitude": 77.2094, "accuracy": 11.0, "recorded_at": "2026-03-10T09:30:30.000Z" }
  ]
}
```

| Field | Constraints |
|-------|-------------|
| `points` | Array, min 1, max 100 items |
| Each point | Same field constraints as single-insert, *without* `session_id` |

**Response `201`:**
```json
{
  "success": true,
  "inserted": 2
}
```

> `inserted` may be less than `points.length` when duplicates are suppressed. The difference is logged as `duplicatesSuppressed`.

---

### `GET /locations/my-route`

Retrieve all GPS points for a specific session belonging to the caller's organization, ordered by `recorded_at` ascending.

**Auth:** JWT + `role: "EMPLOYEE"`  
**Query params:**

| Param | Type | Required |
|-------|------|----------|
| `sessionId` | UUID | Yes |

**Response `200`:**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "session_id": "uuid",
      "organization_id": "uuid",
      "latitude": 28.6139,
      "longitude": 77.2090,
      "accuracy": 12.5,
      "recorded_at": "...",
      "sequence_number": null
    }
  ]
}
```

---

## Expenses Module

---

### `POST /expenses`

Submit a new expense claim. Created with `status: "PENDING"` pending admin review.

**Auth:** JWT + `role: "EMPLOYEE"`  
**Rate limit:** 10 requests per 60 seconds per JWT `sub`

**Request body:**
```json
{
  "amount": 250.50,
  "description": "Fuel for client visit",
  "receipt_url": "https://storage.example.com/receipts/abc123.jpg"
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `amount` | number | Positive |
| `description` | string | 3–500 characters |
| `receipt_url` | string (URL) | Optional; must be a valid URL if provided |

**Response `201`:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "employee_id": "uuid",
    "organization_id": "uuid",
    "amount": 250.50,
    "description": "Fuel for client visit",
    "receipt_url": "https://...",
    "status": "PENDING",
    "created_at": "2026-03-10T10:00:00.000Z"
  }
}
```

---

### `GET /expenses/my`

List the caller's own expense submissions, newest first.

**Auth:** JWT + `role: "EMPLOYEE"`  
**Query params:**

| Param | Type | Default | Constraints |
|-------|------|---------|-------------|
| `page` | integer | `1` | min 1 |
| `limit` | integer | `20` | min 1, max 100 |

**Response `200`:**
```json
{
  "success": true,
  "data": [ /* array of expense records */ ]
}
```

---

### `GET /admin/expenses`

List all expense submissions for the caller's organization, newest first. ADMIN only.

**Auth:** JWT + `role: "ADMIN"`  
**Query params:** Same as `GET /expenses/my`

---

### `PATCH /admin/expenses/:id`

Approve or reject a pending expense. Only `PENDING` expenses can be acted on — attempting to update an already-reviewed expense returns a `400`.

**Auth:** JWT + `role: "ADMIN"`

**Path params:**

| Param | Type | Required |
|-------|------|----------|
| `id` | UUID | Yes |

**Request body:**
```json
{ "status": "APPROVED" }
```

| `status` | Meaning |
|----------|---------|
| `"APPROVED"` | Marks expense as approved |
| `"REJECTED"` | Marks expense as rejected |

**Response `200`:**
```json
{
  "success": true,
  "data": { /* updated expense record */ }
}
```

**Error `400`:** `"Expense has already been reviewed (current status: APPROVED)"` — thrown by `ExpenseAlreadyReviewed`  
**Error `404`:** Expense not found or does not belong to the caller's organization.

---

## Analytics Module

All analytics endpoints require JWT + **ADMIN** role. EMPLOYEE tokens receive `403`.

---

### `GET /admin/org-summary`

Organisation-wide aggregated totals for a given date range.

**Auth:** JWT + `role: "ADMIN"`  
**Query params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | ISO-8601 datetime | No | Range start (inclusive) |
| `to` | ISO-8601 datetime | No | Range end (inclusive) |

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "totalSessions": 142,
    "totalDistanceKm": 4820.5,
    "totalDurationSeconds": 1843200,
    "totalExpenses": 38,
    "approvedExpenseAmount": 9450.00,
    "rejectedExpenseAmount": 550.00,
    "activeEmployeesCount": 12
  }
}
```

---

### `GET /admin/user-summary`

Per-user totals and averages for a given date range.

**Auth:** JWT + `role: "ADMIN"`  
**Query params:**

| Param | Type | Required |
|-------|------|----------|
| `userId` | UUID | **Yes** |
| `from` | ISO-8601 datetime | No |
| `to` | ISO-8601 datetime | No |

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "userId": "uuid",
    "totalSessions": 22,
    "totalDistanceKm": 741.3,
    "totalDurationSeconds": 284400,
    "avgDistanceKmPerSession": 33.7,
    "avgDurationSecondsPerSession": 12927,
    "totalExpenses": 6,
    "approvedExpenseAmount": 1650.00
  }
}
```

---

### `GET /admin/top-performers`

Ranked leaderboard of employees sorted by a chosen metric.

**Auth:** JWT + `role: "ADMIN"`  
**Query params:**

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `metric` | `"distance"` \| `"duration"` \| `"sessions"` | **Yes** | Ranking criterion |
| `from` | ISO-8601 datetime | No | |
| `to` | ISO-8601 datetime | No | |
| `limit` | integer | No | 1–50, default 10 |

**Response `200`:**
```json
{
  "success": true,
  "data": [
    {
      "employeeId": "uuid",
      "totalDistanceKm": 741.3,
      "totalDurationSeconds": 284400,
      "totalSessions": 22
    }
  ]
}
```

Results are ordered descending by the chosen `metric`.

---

## Rate Limit Summary

| Endpoint | Limit | Window | Key |
|----------|-------|--------|-----|
| All routes (global) | 100 req | 1 minute | IP |
| `POST /locations` | 10 req | 10 seconds | JWT `sub` |
| `POST /locations/batch` | 10 req | 10 seconds | JWT `sub` |
| `POST /expenses` | 10 req | 60 seconds | JWT `sub` |
| `POST /attendance/:id/recalculate` | 5 req | 60 seconds | JWT `sub` |

`localhost` / `::1` are exempt from all rate limits (health checks, monitoring scrapes).

When a rate limit is exceeded:
```json
{
  "success": false,
  "error": "Too many requests",
  "retryAfter": "42s"
}
```

---

## JWT Payload Reference

FieldTrack uses **Supabase-issued JWTs**. The backend validates the following claims with Zod:

```json
{
  "sub": "550e8400-e29b-41d4-a716-446655440000",
  "organization_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "role": "EMPLOYEE",
  "iat": 1741600000,
  "exp": 1741686400
}
```

The `organization_id` claim is attached to `request.organizationId` by the `authenticate` middleware and used by every repository method for tenant isolation. No cross-organization data access is possible via the API.
