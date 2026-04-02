import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

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

const EXPENSE_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const pendingExpense = {
  id: EXPENSE_ID,
  employee_id: TEST_EMPLOYEE_ID,
  organization_id: TEST_ORG_ID,
  amount: 75.5,
  description: "Office supplies",
  status: "PENDING",
  receipt_url: null,
  submitted_at: new Date().toISOString(),
  reviewed_at: null,
  reviewed_by: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  employee_code: "EMP001",
  employee_name: "Test Employee",
};

const approvedExpense = {
  ...pendingExpense,
  status: "APPROVED",
  reviewed_by: TEST_ADMIN_ID,
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Expenses Integration Tests", () => {
  let app: FastifyInstance;
  let employeeToken: string;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    employeeToken = signEmployeeToken(app);
    adminToken = signAdminToken(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── POST /expenses ──────────────────────────────────────────────────────────

  describe("POST /expenses", () => {
    it("returns 401 without a JWT", async () => {
      const res = await app.inject({ method: "POST", url: "/expenses" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 when called by an ADMIN without an employee record", async () => {
      // Admin token has no employee_id claim → service rejects with ForbiddenError
      const res = await app.inject({
        method: "POST",
        url: "/expenses",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ amount: 50, description: "Test expense" }),
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 403 when called by an ADMIN who has an employee record (M6 fix)", async () => {
      // M6 fix: admin role is now explicitly rejected before requireEmployeeContext,
      // even if the admin token includes an employee_id claim.
      const adminWithEmployeeToken = app.jwt.sign({
        sub: TEST_ADMIN_ID,
        role: "ADMIN",
        org_id: TEST_ORG_ID,
        employee_id: TEST_ADMIN_ID,
      });

      const res = await app.inject({
        method: "POST",
        url: "/expenses",
        headers: {
          authorization: `Bearer ${adminWithEmployeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ amount: 75.5, description: "Admin expense" }),
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body) as { success: false; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/admin users cannot create expenses/i);
    });

    it("returns 201 with created expense on valid submission", async () => {
      vi.mocked(expensesRepository.createExpense).mockResolvedValue(
        pendingExpense as never,
      );

      const res = await app.inject({
        method: "POST",
        url: "/expenses",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ amount: 75.5, description: "Office supplies" }),
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { success: boolean; data: typeof pendingExpense };
      expect(body.success).toBe(true);
      expect(body.data.status).toBe("PENDING");
    });

    // ─── Schema validation ────────────────────────────────────────────────────

    it("returns 400 when amount is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/expenses",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ description: "No amount" }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when amount is negative", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/expenses",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ amount: -10, description: "Negative amount" }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when amount is zero", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/expenses",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ amount: 0, description: "Zero amount" }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when description is too short (< 3 chars)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/expenses",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ amount: 10, description: "AB" }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when receipt_url is not a valid URL", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/expenses",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          amount: 10,
          description: "Valid description",
          receipt_url: "not-a-url",
        }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── GET /expenses/my ────────────────────────────────────────────────────────

  describe("GET /expenses/my", () => {
    it("returns 401 without a JWT", async () => {
      const res = await app.inject({ method: "GET", url: "/expenses/my" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with employee's expenses", async () => {
      vi.mocked(expensesRepository.findExpensesByUser).mockResolvedValue({
        data: [pendingExpense],
        total: 1,
      } as never);

      const res = await app.inject({
        method: "GET",
        url: "/expenses/my",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
    });

    it("calls repository with authenticated employee id", async () => {
      vi.mocked(expensesRepository.findExpensesByUser).mockResolvedValue({ data: [], total: 0 } as never);

      await app.inject({
        method: "GET",
        url: "/expenses/my",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(expensesRepository.findExpensesByUser).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: TEST_ORG_ID }),
        TEST_EMPLOYEE_ID,
        expect.any(Number),
        expect.any(Number),
      );
    });

    // ─── Pagination behavior ──────────────────────────────────────────────────

    it("accepts valid page and limit params", async () => {
      vi.mocked(expensesRepository.findExpensesByUser).mockResolvedValue({ data: [], total: 0 } as never);

      const res = await app.inject({
        method: "GET",
        url: "/expenses/my?page=2&limit=10",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(expensesRepository.findExpensesByUser).toHaveBeenCalledWith(
        expect.anything(),
        TEST_EMPLOYEE_ID,
        2,
        10,
      );
    });

    it("returns 400 for limit above 1000", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/expenses/my?limit=1500",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for page=0", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/expenses/my?page=0",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── PATCH /admin/expenses/:id ───────────────────────────────────────────────

  describe("PATCH /admin/expenses/:id", () => {
    it("returns 401 without a JWT", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/admin/expenses/${EXPENSE_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 when called by a non-ADMIN employee", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/admin/expenses/${EXPENSE_ID}`,
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "APPROVED" }),
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 200 when ADMIN approves a PENDING expense", async () => {
      vi.mocked(expensesRepository.findExpenseById).mockResolvedValue(
        pendingExpense as never,
      );
      vi.mocked(expensesRepository.updateExpenseStatus).mockResolvedValue(
        approvedExpense as never,
      );

      const res = await app.inject({
        method: "PATCH",
        url: `/admin/expenses/${EXPENSE_ID}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "APPROVED" }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; data: typeof approvedExpense };
      expect(body.success).toBe(true);
      expect(body.data.status).toBe("APPROVED");
    });

    it("returns 400 when trying to re-review an already-approved expense", async () => {
      vi.mocked(expensesRepository.findExpenseById).mockResolvedValue(
        approvedExpense as never,
      );

      const res = await app.inject({
        method: "PATCH",
        url: `/admin/expenses/${EXPENSE_ID}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "REJECTED" }),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error.toLowerCase()).toContain("approved");
    });

    it("returns 404 when expense does not exist", async () => {
      vi.mocked(expensesRepository.findExpenseById).mockResolvedValue(null);

      const res = await app.inject({
        method: "PATCH",
        url: `/admin/expenses/${EXPENSE_ID}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "APPROVED" }),
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 400 for an invalid status value", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/admin/expenses/${EXPENSE_ID}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "PENDING" }),
      });
      // Zod only allows APPROVED | REJECTED
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Multi-tenant isolation ───────────────────────────────────────────────────

  describe("Multi-tenant isolation", () => {
    it("propagates organizationId from JWT when listing expenses", async () => {
      vi.mocked(expensesRepository.findExpensesByUser).mockResolvedValue({ data: [], total: 0 } as never);

      const tokenOrgB = signEmployeeToken(app, TEST_EMPLOYEE_ID, TEST_ORG_ID_B);
      await app.inject({
        method: "GET",
        url: "/expenses/my",
        headers: { authorization: `Bearer ${tokenOrgB}` },
      });

      expect(expensesRepository.findExpensesByUser).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: TEST_ORG_ID_B }),
        TEST_EMPLOYEE_ID,
        expect.any(Number),
        expect.any(Number),
      );
    });
  });
});
