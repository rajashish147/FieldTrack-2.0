# Contributing to FieldTrack API

---

## Setup

**Prerequisites:** Node.js ≥ 24, npm, Redis

```bash
git clone https://github.com/fieldtrack-tech/api.git
cd api

npm install
cp .env.example .env
# Edit .env — fill in Supabase URL, keys, Redis URL, ALLOWED_ORIGINS
```

---

## Branch Naming

| Purpose | Pattern | Example |
|---------|---------|---------|
| New feature | `feature/<description>` | `feature/expense-attachments` |
| Bug fix | `fix/<description>` | `fix/session-double-close` |
| Infrastructure | `infra/<description>` | `infra/add-redis-tls` |
| Documentation | `docs/<description>` | `docs/update-api-reference` |
| Tests | `test/<description>` | `test/analytics-edge-cases` |
| Chores / deps | `chore/<description>` | `chore/bump-fastify-5` |

All PRs target `master`. `master` is protected — CI must pass before merge.

---

## Commit Format

```
type(scope): short imperative description
```

**Allowed types:**

| Type | When to use |
|------|-------------|
| `feat` | New user-facing functionality |
| `fix` | Bug fix |
| `refactor` | Internal code change — no behaviour change |
| `ci` | CI/CD workflow changes |
| `infra` | Infrastructure, Docker, nginx, monitoring |
| `docs` | Documentation only |
| `test` | Adding or updating tests |
| `chore` | Dependency bumps, tooling, housekeeping |

**Scope** should be the module or layer affected (e.g. `auth`, `expenses`, `analytics`, `deploy`, `worker`, `rls`).

**Examples:**

```
feat(expenses): add bulk-approve endpoint for admins
fix(auth): handle missing organization_id claim in JWT
refactor(analytics): replace read-then-upsert with atomic RPC calls
ci(deploy): add SARIF-based Trivy gate before image push
infra(nginx): block /docs and /openapi.json in production
docs(deployment): document blue-green rollback procedure
test(attendance): cover double-checkout edge case
chore(deps): bump @fastify/jwt to 9.1.0
```

---

## Development Workflow

### Making Changes

1. Branch off `master`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes following the existing code conventions (TypeScript strict mode, ESM imports, Fastify patterns).

3. Run the test suite and type-checker before committing:
   ```bash
   npm run typecheck
   npm test
   ```

4. Commit with a conventional commit message (see format above).

5. Push your branch and open a pull request against `master`.

---

## Code Conventions

### Module Pattern

Every domain module follows the same four-layer pattern:

```
src/modules/<domain>/
├── <domain>.schema.ts      — Zod schemas and TypeScript types
├── <domain>.repository.ts  — Supabase queries, always scoped by organization_id
├── <domain>.service.ts     — Business logic, throws domain errors
├── <domain>.controller.ts  — HTTP parsing, calls service, sends response via handleError
└── <domain>.routes.ts      — Route registration, middleware, rate-limit config
```

### Key Rules

- **Never skip tenant scoping.** Every repository query must include `.eq("organization_id", organizationId)`.
- **All errors must flow through `handleError()`.** Do not call `reply.status().send()` directly in service or repository code.
- **Domain errors belong in `src/utils/errors.ts`.** Use specific error classes (`NotFoundError`, `ForbiddenError`, etc.) rather than generic ones.
- **Use `TenantContext`** when writing service-layer code that runs outside an HTTP request (e.g. workers).
- **All new endpoints need a rate limit.** Check existing routes for examples of per-user (JWT `sub`) rate limiting.

### Testing

- Unit tests go in `tests/unit/`
- Integration tests go in `tests/integration/`
- Use `vi.mock()` at the top of integration test files to mock repository dependencies
- Use `TEST_UUID()` from `tests/helpers/uuid.ts` for all UUID values in tests (Zod 4 enforces strict RFC-4122 validation)
- Do not write tests that require a live Supabase project — mock at the repository level

---

## Pull Request Process

1. Ensure `npx tsc --noEmit` exits `0`
2. Ensure `npm run test` passes all 124+ tests
3. Write tests for new behaviour — PRs without tests for new endpoints will not be merged
4. Update [docs/API_REFERENCE.md](docs/API_REFERENCE.md) if you add or change any endpoint
5. Update [CHANGELOG.md](CHANGELOG.md) with a short entry under the appropriate section

---

## Reporting Issues

Use GitHub Issues. Include:

- Node.js version (`node --version`)
- What you expected to happen
- What actually happened
- Minimal reproduction steps

For security vulnerabilities, see [SECURITY.md](SECURITY.md) instead.
