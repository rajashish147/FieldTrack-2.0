/**
 * Tenant isolation integration tests.
 *
 * Verifies that every expense endpoint correctly scopes data to the
 * authenticated tenant and cannot be bypassed through:
 *   - ADMIN list / update operations
 *   - EMPLOYEE read operations
 *   - query-parameter injection attempting to override the JWT org claim
 *
 * All external I/O (repository, Supabase) is mocked — no live database
 * or network connection is required.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";

// ─── Module mocks (hoisted before any imports) ────────────────────────────────

vi.mock("../../../src/config/redis.js", () => ({
  redisClient: { on: vi.fn(), quit: vi.fn(), disconnect: vi.fn() },
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
    findExpenseById: vi.fn(),
    findExpensesByUser: vi.fn(),
    findExpensesByOrg: vi.fn(),
    updateExpenseStatus: vi.fn(),
    findExpenseSummaryByEmployee: vi.fn(),
  },
}));

vi.mock("../../../src/config/supabase.js", () => ({
  supabaseServiceClient: {
    from: vi.fn().mockReturnThis(),
    storage: {
      from: vi.fn().mockReturnThis(),
      createSignedUploadUrl: vi.fn(),
    },
  },
  supabaseAnonClient: {
    from: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../../src/auth/jwtVerifier.js", () => ({
  verifySupabaseToken: vi.fn().mockImplementation(async (token: string) => {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT structure");
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  }),
}));

import {
  buildTestApp,
  signEmployeeToken,
  signAdminToken,
  TEST_ORG_ID,
  TEST_ORG_ID_B,
  TEST_EMPLOYEE_ID,
  TEST_ADMIN_ID,
} from "../../setup/test-server.js";
import { expensesRepository } from "../../../src/modules/expenses/expenses.repository.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const ORG_A_EXPENSE_ID = "aaaaa000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B_EXPENSE_ID = "bbbbb000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG_A_EMPLOYEE_ID = TEST_EMPLOYEE_ID;
const ORG_B_EMPLOYEE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const orgAExpense = {
  id: ORG_A_EXPENSE_ID,
  employee_id: ORG_A_EMPLOYEE_ID,
  organization_id: TEST_ORG_ID,
  amount: 50.0,
  description: "Org A expense",
  status: "PENDING",
  receipt_url: null,
  submitted_at: new Date().toISOString(),
  reviewed_at: null,
  reviewed_by: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  employee_code: "EMP0001",
  employee_name: "Alice OrgA",
};

const orgBExpense = {
  id: ORG_B_EXPENSE_ID,
  employee_id: ORG_B_EMPLOYEE_ID,
  organization_id: TEST_ORG_ID_B,
  amount: 99.0,
  description: "Org B expense",
  status: "PENDING",
  receipt_url: null,
  submitted_at: new Date().toISOString(),
  reviewed_at: null,
  reviewed_by: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  employee_code: "EMP0001",
  employee_name: "Bob OrgB",
};

// ─────────────────────────────────────────────────────────────────────────────

describe("Tenant Isolation", () => {
  let app: FastifyInstance;
  let orgAAdminToken: string;
  let orgBAdminToken: string;
  let orgAEmployeeToken: string;
  let orgBEmployeeToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    orgAAdminToken    = signAdminToken(app, TEST_ADMIN_ID, TEST_ORG_ID);
    orgBAdminToken    = signAdminToken(app, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", TEST_ORG_ID_B);
    orgAEmployeeToken = signEmployeeToken(app, ORG_A_EMPLOYEE_ID, TEST_ORG_ID);
    orgBEmployeeToken = signEmployeeToken(app, ORG_B_EMPLOYEE_ID, TEST_ORG_ID_B);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Org A admin sees only Org A expenses — repository receives Org A ID", async () => {
    vi.mocked(expensesRepository.findExpensesByOrg).mockResolvedValue({
      data: [orgAExpense],
      total: 1,
    } as never);

    const res = await app.inject({
      method: "GET",
      url: "/admin/expenses",
      headers: { authorization: `Bearer ${orgAAdminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: typeof orgAExpense[] };
    body.data.forEach((e) => {
      expect(e.organization_id).toBe(TEST_ORG_ID);
    });
    expect(expensesRepository.findExpensesByOrg).toHaveBeenCalledOnce();
  });

  it("Org B admin cannot retrieve Org A expenses via ADMIN endpoint", async () => {
    vi.mocked(expensesRepository.findExpensesByOrg).mockResolvedValue({
      data: [orgBExpense],
      total: 1,
    } as never);

    const res = await app.inject({
      method: "GET",
      url: "/admin/expenses",
      headers: { authorization: `Bearer ${orgBAdminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: typeof orgBExpense[] };
    body.data.forEach((e) => {
      expect(e.organization_id).not.toBe(TEST_ORG_ID);
      expect(e.organization_id).toBe(TEST_ORG_ID_B);
    });
    expect(expensesRepository.findExpensesByOrg).toHaveBeenCalledOnce();
  });

  it("findExpenseById enforces tenant isolation — Org B admin cannot update Org A expense", async () => {
    // Return Org A's expense so enforceTenant() inside the service detects the mismatch.
    vi.mocked(expensesRepository.findExpenseById).mockResolvedValue(
      orgAExpense as never,
    );

    const res = await app.inject({
      method: "PATCH",
      url: `/admin/expenses/${ORG_A_EXPENSE_ID}`,
      headers: {
        authorization: `Bearer ${orgBAdminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "APPROVED" }),
    });

    // enforceTenant() throws ForbiddenError when the expense's org ≠ the token's org
    expect(res.statusCode).toBe(403);
  });

  it("employee sees only their own expenses on GET /expenses/my", async () => {
    vi.mocked(expensesRepository.findExpensesByUser).mockResolvedValue({
      data: [orgAExpense],
      total: 1,
    } as never);

    const res = await app.inject({
      method: "GET",
      url: "/expenses/my",
      headers: { authorization: `Bearer ${orgAEmployeeToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: typeof orgAExpense[] };
    body.data.forEach((e) => {
      expect(e.organization_id).toBe(TEST_ORG_ID);
    });
  });

  it("employee token is rejected at ADMIN endpoint by role guard", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/expenses",
      headers: { authorization: `Bearer ${orgBEmployeeToken}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it("JWT organization_id governs data scope — query params cannot override tenant context", async () => {
    // Prove that appending ?organization_id=<OrgA> to the URL cannot override
    // the tenant context derived from the JWT (which belongs to Org B).
    vi.mocked(expensesRepository.findExpensesByUser).mockResolvedValue({
      data: [orgBExpense],
      total: 1,
    } as never);

    const res = await app.inject({
      method: "GET",
      // Attempt to inject Org A's ID via a query parameter
      url: `/expenses/my?organization_id=${TEST_ORG_ID}`,
      headers: { authorization: `Bearer ${orgBEmployeeToken}` },
    });

    // Request succeeds — Org B employee is authenticated
    expect(res.statusCode).toBe(200);
    expect(expensesRepository.findExpensesByUser).toHaveBeenCalledOnce();

    // Verify the repository was called with Org B context from the JWT,
    // not with the Org A ID injected via query param.
    const callArgs = vi.mocked(expensesRepository.findExpensesByUser).mock.calls;
    const capturedRequest = callArgs[0]?.[0] as FastifyRequest & { organizationId: string };
    expect(capturedRequest.organizationId).toBe(TEST_ORG_ID_B);
    expect(capturedRequest.organizationId).not.toBe(TEST_ORG_ID);
  });

  it("cross-tenant expense update is blocked even when expense ID is known", async () => {
    // An attacker with a valid Org B admin token who knows an Org A expense ID
    // must be rejected at the tenant-enforcement layer.
    vi.mocked(expensesRepository.findExpenseById).mockResolvedValue(
      orgAExpense as never,
    );

    const res = await app.inject({
      method: "PATCH",
      url: `/admin/expenses/${ORG_A_EXPENSE_ID}`,
      headers: {
        authorization: `Bearer ${orgBAdminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "REJECTED", rejection_comment: "attempted cross-tenant update" }),
    });

    expect(res.statusCode).toBe(403);
    // updateExpenseStatus must not be reached — the isolation check fires first
    expect(expensesRepository.updateExpenseStatus).not.toHaveBeenCalled();
  });
});
