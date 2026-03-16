# Contributing to FieldTrack 2.0

Thank you for your interest in contributing. This document explains the workflow for submitting changes.

---

## Getting Started

### Prerequisites

- Node.js ≥ 24
- npm
- Redis (for integration tests that use BullMQ)
- A Supabase project (for full integration runs) — test suite mocks the DB layer so Supabase is not required for unit tests

### Setup

```bash
# Clone the repository
git clone https://github.com/rajashish147/FieldTrack-2.0.git
cd FieldTrack-2.0/backend

# Install dependencies
npm install

# Copy and configure env
cp .env.example .env
# Edit .env with your Supabase and Redis credentials
```

---

## Development Workflow

### Branching

- `master` — production branch; protected, requires passing CI
- Feature branches: `feat/<short-description>`
- Bug fixes: `fix/<short-description>`
- Documentation: `docs/<short-description>`

### Making Changes

1. Branch off `master`:
   ```bash
   git checkout -b feat/your-feature-name
   ```

2. Make your changes following the existing code conventions (TypeScript strict mode, ESM imports, Fastify patterns).

3. Run the test suite and type-checker before committing:
   ```bash
   # From the backend/ directory
   npx tsc --noEmit
   npm run test
   ```

4. Commit with a conventional commit message:
   ```
   feat(module): short description of change
   fix(auth): handle missing organization_id claim
   docs(readme): update deployment instructions
   chore(deps): bump fastify to 5.x
   ```

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
