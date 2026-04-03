# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest (`master` branch) | ✅ |
| Older tags | ❌ |

Only the current `master` branch receives security fixes.

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report security issues privately by emailing:

> **fieldtrack-tech [at] gmail.com**

Include in your report:

1. A description of the vulnerability
2. The file(s) or component(s) affected
3. Steps to reproduce (if applicable)
4. Potential impact assessment
5. Any suggested fix (optional but appreciated)

You will receive an acknowledgement within **48 hours** and a resolution timeline within **7 days** for confirmed vulnerabilities.

---

## Known Security Decisions

### JWT Algorithm Enforcement (Production Hardening)

**Vulnerability:** CVE-2023-48223 (fast-jwt algorithm confusion)

**Context:**
- This project uses ES256 (ECDSA, asymmetric) JWTs issued by Supabase
- `@fastify/jwt` package has a transitive dependency on `fast-jwt@^6.0.2`, which is vulnerable
- However, **production code NEVER uses `fast-jwt` directly**

**Mitigation:**
- **Production:** Uses `jsonwebtoken` + `jwks-rsa` for verification (completely separate library, not vulnerable)
- **Tests:** Uses `@fastify/jwt` (HS256, test-only, matches test secret in CI environment)
- **Enforcement:** `algorithms: ["ES256"]` is explicitly set in jwtVerifier.ts (line 107)
- **Defense-in-depth:** Header algorithm is validated before signature verification (extra safety)

**Risk Level:** LOW

**Why this is safe:**
1. Asymmetric keys (JWKS endpoint): CVE-2023-48223 exploits symmetric key confusion, which cannot happen with asymmetric keys
2. Explicit algorithm restriction to ES256 prevents fallback to HS256
3. Token audience is validated (blocks service_role tokens)
4. Test environment is isolated; fast-jwt is not used in production

**Monitoring:**
- Waiting for upstream `fast-jwt` fix
- CI audit check overrides only for "critical" level (not "high")
- `@fastify/jwt` will be updated when fast-jwt is fixed

---

## Scope

### In scope

- Authentication and authorization bypasses
- Tenant isolation failures (cross-organization data access)
- JWT validation weaknesses
- SQL injection or data exfiltration via Supabase queries
- Rate limiting bypasses that could enable denial-of-service
- Sensitive data exposure (logs, error responses, API responses)
- Remote code execution vulnerabilities
- Dependency vulnerabilities with known CVEs affecting production functionality

### Out of scope

- Issues in the example/test environment configuration (`tests/setup/env-setup.ts` uses intentionally fake credentials)
- Vulnerabilities that require physical access to the VPS
- Issues in third-party services (Supabase, GitHub, GHCR)
- Theoretical vulnerabilities without a working proof of concept

---

## Security Design Notes

These design decisions are intentional and not vulnerabilities:

- `sequence_number` in `gps_locations` is **nullable by design** during mobile stabilization — ordering falls back to `recorded_at`
- `GET /debug/redis` is **disabled in production** (`NODE_ENV=production` returns 404) — this is enforced in code, not just config
- JWT claims are re-validated on every request using Zod — stale or malformed claims are rejected even if the signature is valid
- Rate-limit counters are stored in Redis with a **separate connection** from the job queue to prevent counter manipulation via queue exhaustion

---

## Dependency Security

Dependencies are managed via `npm ci` (deterministic installs from `package-lock.json`). To audit for known vulnerabilities:

```bash
cd backend
npm audit
```

Critical and high severity vulnerabilities in production dependencies block deployment via CI.
