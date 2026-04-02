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
    findExpenseSummaryByEmployee: vi.fn(),
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
  TEST_EMPLOYEE_ID,
} from "../../setup/test-server.js";
import { expensesRepository } from "../../../src/modules/expenses/expenses.repository.js";
import type { EmployeeExpenseSummary } from "@fieldtrack/types";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const SUMMARY_ROWS: EmployeeExpenseSummary[] = [
  {
    employeeId: TEST_EMPLOYEE_ID,
    employeeName: "Test Employee",
    employeeCode: "EMP001",
    pendingCount: 2,
    pendingAmount: 150.0,
    totalCount: 5,
    totalAmount: 425.5,
    latestExpenseDate: new Date().toISOString(),
  },
  {
    employeeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    employeeName: "Second Employee",
    employeeCode: "EMP002",
    pendingCount: 0,
    pendingAmount: 0,
    totalCount: 3,
    totalAmount: 200.0,
    latestExpenseDate: new Date(Date.now() - 86_400_000).toISOString(),
  },
];

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("GET /admin/expenses/summary", () => {
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
    vi.mocked(expensesRepository.findExpenseSummaryByEmployee).mockResolvedValue({
      data: SUMMARY_ROWS,
      total: SUMMARY_ROWS.length,
    });
  });

  // ─── Auth & role guards ───────────────────────────────────────────────────

  it("returns 401 when no JWT is provided", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/expenses/summary" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when called with an employee token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/expenses/summary",
      headers: { authorization: `Bearer ${employeeToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── Happy path ───────────────────────────────────────────────────────────

  it("returns 200 with paginated summary rows for admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/expenses/summary?page=1&limit=25",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; data: EmployeeExpenseSummary[]; pagination: { page: number; limit: number; total: number } }>();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.pagination).toMatchObject({ page: 1, limit: 25, total: 2 });

    // First row has pending expenses
    const first = body.data[0];
    expect(first.employeeId).toBe(TEST_EMPLOYEE_ID);
    expect(first.pendingCount).toBe(2);
    expect(first.pendingAmount).toBe(150.0);
    expect(first.totalCount).toBe(5);
  });

  it("calls repository with correct page/limit from query params", async () => {
    await app.inject({
      method: "GET",
      url: "/admin/expenses/summary?page=2&limit=10",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(expensesRepository.findExpenseSummaryByEmployee).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: TEST_ORG_ID }),
      2,
      10,
    );
  });

  it("defaults to page=1 limit=50 when query params are omitted", async () => {
    await app.inject({
      method: "GET",
      url: "/admin/expenses/summary",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(expensesRepository.findExpenseSummaryByEmployee).toHaveBeenCalledWith(
      expect.anything(),
      1,
      50,
    );
  });

  it("returns 200 with empty data when no expenses exist", async () => {
    vi.mocked(expensesRepository.findExpenseSummaryByEmployee).mockResolvedValue({
      data: [],
      total: 0,
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/expenses/summary",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; data: unknown[]; pagination: { total: number } }>();
    expect(body.data).toHaveLength(0);
    expect(body.pagination.total).toBe(0);
  });

  it("returns 500 when repository throws", async () => {
    vi.mocked(expensesRepository.findExpenseSummaryByEmployee).mockRejectedValue(
      new Error("DB connection lost"),
    );

    const res = await app.inject({
      method: "GET",
      url: "/admin/expenses/summary",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(500);
  });
});
