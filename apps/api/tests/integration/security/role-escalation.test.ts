/**
 * Role-escalation prevention integration tests.
 *
 * Verifies the C1 security fix: the authentication middleware reads the
 * application role from the top-level `role` JWT claim (server-controlled,
 * injected by the custom_access_token_hook) and NOT from `user_metadata.role`
 * (user-editable via supabase.auth.updateUser()).
 *
 * Without this fix an EMPLOYEE could call:
 *   await supabase.auth.updateUser({ data: { role: "ADMIN" } })
 * and their next JWT would carry user_metadata.role = "ADMIN", granting them
 * full admin access to every admin route.
 *
 * These tests run the JWKS / production code path of auth.ts by setting
 * APP_ENV to "production" and mocking verifySupabaseToken directly.
 *
 * External I/O (Redis, Supabase DB, JWKS endpoint) is fully mocked.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerZod } from "../../../src/plugins/zod.plugin.js";
import { AppError } from "../../../src/utils/errors.js";

// ─── Module mocks (must be hoisted before any application imports) ────────────

// Switch the auth middleware into production mode so it uses verifySupabaseToken
// instead of @fastify/jwt.
vi.mock("../../../src/config/env.js", () => ({
  env: {
    APP_ENV: "production",
    NODE_ENV: "test",
  },
}));

// Mock JWKS verifier — controlled per-test via mockResolvedValueOnce
vi.mock("../../../src/auth/jwtVerifier.js", () => ({
  verifySupabaseToken: vi.fn(),
}));

// Prevent Redis connection attempts
vi.mock("../../../src/config/redis.js", () => ({
  redisClient: { on: vi.fn(), quit: vi.fn(), disconnect: vi.fn() },
}));

// Prevent Supabase DB calls (the test payloads always embed org_id directly in
// the top-level JWT claims so the DB lookup path is never taken)
vi.mock("../../../src/config/supabase.js", () => ({
  supabaseServiceClient: {
    from: vi.fn().mockReturnThis(),
    storage: { from: vi.fn().mockReturnThis() },
  },
  supabaseAnonClient: { from: vi.fn().mockReturnThis() },
}));

// Prevent cache reads/writes
vi.mock("../../../src/utils/cache.js", () => ({
  getCached: vi.fn((_key: string, _ttl: number, factory: () => Promise<unknown>) => factory()),
  invalidateOrgAnalytics: vi.fn(),
}));

vi.mock("../../../src/workers/distance.queue.js", () => ({
  enqueueDistanceJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../src/workers/analytics.queue.js", () => ({
  enqueueAnalyticsJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../src/modules/expenses/expenses.repository.js", () => ({
  expensesRepository: {
    createExpense: vi.fn(),
    findExpensesByUser: vi.fn(),
    findExpensesByOrg: vi.fn(),
    findExpenseById: vi.fn(),
    updateExpenseStatus: vi.fn(),
    findExpenseSummaryByEmployee: vi.fn(),
  },
}));

// ─── Application imports (after mocks are set up) ────────────────────────────

import { authenticate } from "../../../src/middleware/auth.js";
import { requireRole } from "../../../src/middleware/role-guard.js";
import { verifySupabaseToken } from "../../../src/auth/jwtVerifier.js";
import type { SupabaseJwtPayload } from "../../../src/auth/jwtVerifier.js";
import { TEST_ORG_ID } from "../../setup/test-server.js";

// Valid RFC 4122 v4 UUIDs: version nibble (3rd group) must start with [4],
// variant nibble (4th group) must start with [89ab].
// TEST_EMPLOYEE_ID / TEST_ADMIN_ID from test-server.ts are NOT valid v4 UUIDs
// (their 3rd group is "aaaa" / "bbbb"). The production code path runs
// uuidValidate(userId) which rejects those, so we define dedicated IDs here.
const PROD_TEST_EMPLOYEE_ID = "11111111-1111-4111-9111-111111111111";
const PROD_TEST_ADMIN_ID    = "33333333-3333-4333-8333-333333333333";

// ─── Minimal test app with one protected route per role ──────────────────────

async function buildProductionModeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  registerZod(app);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({
        success: false,
        error: error.message,
        requestId: request.id,
      });
      return;
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    void reply.status(status).send({
      success: false,
      error: error.message,
      requestId: request.id,
    });
  });

  // EMPLOYEE-accessible route
  app.get(
    "/expenses/my",
    { preHandler: [authenticate, requireRole("EMPLOYEE")] },
    async () => ({ success: true, data: [] }),
  );

  // ADMIN-only route
  app.get(
    "/admin/expenses",
    { preHandler: [authenticate, requireRole("ADMIN")] },
    async () => ({ success: true, data: [] }),
  );

  await app.ready();
  return app;
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Builds a Supabase-shaped JWT payload with top-level hook claims and user_metadata. */
function makePayload(opts: {
  sub: string;
  appRole: string;
  userMetaRole: string;
  orgId?: string;
}): SupabaseJwtPayload {
  return {
    sub: opts.sub,
    email: "test@example.com",
    aud: "authenticated",
    role: opts.appRole,                      // top-level — injected by custom_access_token_hook
    org_id: opts.orgId ?? TEST_ORG_ID,       // top-level — injected by hook
    employee_id: opts.sub,                   // top-level — injected by hook (EMPLOYEE role)
    user_metadata: {
      role: opts.userMetaRole, // user-controlled, must never drive authorization
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Role escalation prevention (C1 fix)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildProductionModeApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Core escalation scenario ──────────────────────────────────────────────

  it("denies admin route when JWT role=EMPLOYEE, regardless of user_metadata.role=ADMIN", async () => {
    vi.mocked(verifySupabaseToken).mockResolvedValueOnce(
      makePayload({
        sub: PROD_TEST_EMPLOYEE_ID,
        appRole: "EMPLOYEE",        // authoritative server-set role
        userMetaRole: "ADMIN",      // attempted escalation by user
      }),
    );

    const res = await app.inject({
      method: "GET",
      url: "/admin/expenses",
      headers: { authorization: "Bearer fake-escalated-token" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("grants employee route when JWT role=EMPLOYEE, even if user_metadata.role=ADMIN", async () => {
    vi.mocked(verifySupabaseToken).mockResolvedValueOnce(
      makePayload({
        sub: PROD_TEST_EMPLOYEE_ID,
        appRole: "EMPLOYEE",
        userMetaRole: "ADMIN",
      }),
    );

    const res = await app.inject({
      method: "GET",
      url: "/expenses/my",
      headers: { authorization: "Bearer fake-escalated-token" },
    });

    expect(res.statusCode).toBe(200);
  });

  // ── Legitimate ADMIN token ────────────────────────────────────────────────

  it("grants admin route when JWT role=ADMIN and user_metadata.role=ADMIN", async () => {
    vi.mocked(verifySupabaseToken).mockResolvedValueOnce(
      makePayload({
        sub: PROD_TEST_ADMIN_ID,
        appRole: "ADMIN",
        userMetaRole: "ADMIN",
      }),
    );

    const res = await app.inject({
      method: "GET",
      url: "/admin/expenses",
      headers: { authorization: "Bearer fake-admin-token" },
    });

    expect(res.statusCode).toBe(200);
  });

  // ── Legitimate EMPLOYEE token (no escalation) ─────────────────────────────

  it("grants employee route when both metadata roles are EMPLOYEE (normal flow)", async () => {
    vi.mocked(verifySupabaseToken).mockResolvedValueOnce(
      makePayload({
        sub: PROD_TEST_EMPLOYEE_ID,
        appRole: "EMPLOYEE",
        userMetaRole: "EMPLOYEE",
      }),
    );

    const res = await app.inject({
      method: "GET",
      url: "/expenses/my",
      headers: { authorization: "Bearer fake-employee-token" },
    });

    expect(res.statusCode).toBe(200);
  });

  // ── Missing top-level role ────────────────────────────────────────────────

  it("rejects when top-level role claim is absent (hook not enabled for this token)", async () => {
    vi.mocked(verifySupabaseToken).mockResolvedValueOnce({
      sub: PROD_TEST_EMPLOYEE_ID,
      email: "test@example.com",
      aud: "authenticated",
      org_id: TEST_ORG_ID,
      // role intentionally omitted — simulates a legacy token minted before hook deployed
      user_metadata: { role: "EMPLOYEE" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/expenses/my",
      headers: { authorization: "Bearer fake-legacy-token" },
    });

    expect(res.statusCode).toBe(401);
  });

  // ── Downgrade attempt: ADMIN tries to masquerade as EMPLOYEE ─────────────

  it("denies employee route when JWT role=ADMIN but user_metadata.role=EMPLOYEE", async () => {
    // An admin whose user_metadata.role was set to "EMPLOYEE" (e.g. support clearing a flag)
    // should still only get admin access — the employee route requires role=EMPLOYEE.
    // This tests that the top-level JWT role is read and requireRole("EMPLOYEE") fires for ADMINs.
    vi.mocked(verifySupabaseToken).mockResolvedValueOnce(
      makePayload({
        sub: PROD_TEST_ADMIN_ID,
        appRole: "ADMIN",
        userMetaRole: "EMPLOYEE",
      }),
    );

    const res = await app.inject({
      method: "GET",
      url: "/expenses/my",
      headers: { authorization: "Bearer fake-downgrade-token" },
    });

    // An ADMIN token hits requireRole("EMPLOYEE") → 403 since role=ADMIN ≠ EMPLOYEE
    expect(res.statusCode).toBe(403);
  });
});
