# FieldTrack API — Quick Start Guide

This guide explains how to access and use the FieldTrack API documentation and authentication.

---

## Access Interactive Documentation

### Swagger UI

FieldTrack provides interactive API documentation powered by **Swagger UI** with OpenAPI 3.0 specification.

**Local Development:**
```
http://localhost:4000/docs
```

**Production:**
```
https://api.fieldtrack.app/docs
```

### OpenAPI Specification

The raw OpenAPI 3.0 JSON specification is available at:

**Local:**
```
http://localhost:4000/openapi.json
```

**Production:**
```
https://api.fieldtrack.app/openapi.json
```

This can be imported into API clients like Postman, Insomnia, or used for code generation.

---

## Authentication

All API endpoints (except `/health` and `/metrics`) require JWT authentication.

### Obtaining a Token

Tokens are issued by **Supabase Auth**. Authenticate using your Supabase client:

```javascript
const { data, error } = await supabase.auth.signInWithPassword({
  email: 'user@example.com',
  password: 'your-password'
});

const token = data.session.access_token;
```

### Using the Token

Include the JWT token in the `Authorization` header of all API requests:

```
Authorization: Bearer <your-jwt-token>
```

### Authenticating in Swagger UI

1. Open Swagger UI at `/docs`
2. Click the **Authorize** button (🔒 icon) in the top-right corner
3. In the "BearerAuth" dialog, enter your token:
   ```
   Bearer <your-jwt-token>
   ```
   Or just the token itself (without the "Bearer " prefix)
4. Click **Authorize**
5. Click **Close**

All subsequent "Try it out" requests will automatically include your authentication token.

---

## Basic Example API Calls

### Health Check (No Auth)

```bash
curl http://localhost:4000/health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-03-10T15:30:00.000Z"
}
```

### Check In (Requires Auth)

```bash
curl -X POST http://localhost:4000/attendance/check-in \
  -H "Authorization: Bearer <your-jwt-token>" \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "user_id": "123e4567-e89b-12d3-a456-426614174000",
    "organization_id": "789e0123-e89b-12d3-a456-426614174000",
    "checked_in_at": "2026-03-10T15:30:00.000Z",
    "status": "ACTIVE"
  }
}
```

### Get My Sessions (Requires Auth, with Pagination)

```bash
curl "http://localhost:4000/attendance/my-sessions?page=1&limit=20" \
  -H "Authorization: Bearer <your-jwt-token>"
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "checked_in_at": "2026-03-10T09:00:00.000Z",
      "checked_out_at": "2026-03-10T17:00:00.000Z",
      "status": "COMPLETED"
    }
  ]
}
```

---

## Pagination

List endpoints support pagination via query parameters:

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `page` | integer | 1 | - | Page number (1-indexed) |
| `limit` | integer | 20 | 100 | Items per page |

**Example:**
```
GET /attendance/my-sessions?page=2&limit=50
```

---

## Standard Response Format

### Success Response

All successful API responses follow this envelope pattern:

```json
{
  "success": true,
  "data": { /* response payload */ }
}
```

### Error Response

All error responses include:

```json
{
  "success": false,
  "error": "Human-readable error message",
  "requestId": "uuid-for-tracing"
}
```

**Common HTTP Status Codes:**

| Code | Meaning |
|------|---------|
| `200` | Success |
| `400` | Validation error or business rule violation |
| `401` | Missing or invalid authentication token |
| `403` | Insufficient permissions (wrong role) |
| `404` | Resource not found |
| `429` | Rate limit exceeded |
| `500` | Internal server error |

---

## API Organization

Endpoints are grouped into the following categories:

### Health
- `GET /health` — Server health check

### Attendance
- `POST /attendance/check-in` — Start attendance session
- `POST /attendance/check-out` — End attendance session
- `GET /attendance/my-sessions` — List your sessions
- `POST /attendance/:sessionId/recalculate` — Recalculate session metrics

### Locations
- `POST /locations` — Record GPS location
- `POST /locations/batch` — Record multiple GPS locations
- `GET /locations/my-route` — Get your location history

### Expenses
- `POST /expenses` — Create expense claim
- `GET /expenses/my` — List your expenses

### Analytics (ADMIN Only)
- `GET /admin/org-summary` — Organization-wide summary
- `GET /admin/user-summary` — Per-user summary
- `GET /admin/top-performers` — Leaderboard

### Admin Operations
- `GET /admin/expenses` — List all organization expenses
- `PATCH /admin/expenses/:id` — Approve/reject expense
- `GET /attendance/org-sessions` — List all organization sessions

---

## Rate Limiting

Some endpoints are rate-limited to prevent abuse:

| Endpoint | Limit |
|----------|-------|
| `POST /locations` | 10 requests per 10 seconds per user |
| `POST /locations/batch` | 10 requests per 10 seconds per user |
| `POST /expenses` | 10 requests per 60 seconds per user |
| `POST /attendance/:sessionId/recalculate` | 5 requests per 60 seconds per user |

When rate limited, the API returns `429 Too Many Requests` with:

```json
{
  "success": false,
  "error": "Too many requests",
  "retryAfter": "30s"
}
```

---

## Request Tracing

Every response includes an `x-request-id` header for distributed tracing:

```
x-request-id: 123e4567-e89b-12d3-a456-426614174000
```

If you encounter an error, include this ID when contacting support.

---

## Further Documentation

For complete endpoint details, schemas, and examples:

- **Swagger UI**: `/docs` (interactive)
- **API Reference**: [docs/API_REFERENCE.md](./API_REFERENCE.md) (detailed text reference)
- **Architecture**: [docs/ARCHITECTURE.md](./ARCHITECTURE.md) (system design)

---

## Development Tools

### Using Postman

1. Import the OpenAPI spec from `/openapi.json`
2. Set up an environment variable for your JWT token
3. Add to Headers: `Authorization: Bearer {{token}}`

### Using cURL

Store your token in an environment variable:

```bash
export FIELDTRACK_TOKEN="your-jwt-token-here"

curl -X POST http://localhost:4000/attendance/check-in \
  -H "Authorization: Bearer $FIELDTRACK_TOKEN" \
  -H "Content-Type: application/json"
```

### Using HTTPie

```bash
http POST http://localhost:4000/attendance/check-in \
  Authorization:"Bearer $FIELDTRACK_TOKEN"
```

---

## Support

For issues or questions:

- Check the **Swagger UI** at `/docs` for interactive examples
- Review [API_REFERENCE.md](./API_REFERENCE.md) for detailed documentation
- Check [ARCHITECTURE.md](./ARCHITECTURE.md) for system design details
- Contact support with the `x-request-id` header value for debugging
