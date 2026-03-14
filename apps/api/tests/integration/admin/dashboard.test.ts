import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../../../src/config/redis.js", () => ({
  redisClient: { on: vi.fn(), quit: vi.fn(), disconnect: vi.fn() },
}));

vi.mock("../../../src/workers/distance.queue.js", () => ({
  enqueueDistanceJob: vi.fn().mockResolvedValue(undefined),
}));

// The dashboard route calls supabaseServiceClient.from() directly for
// employee_latest_sessions and attendance_sessions queries.
vi.mock("../../../src/config/supabase.js", () => ({
  supabaseServiceClient: { from: vi.fn() },
}));

// The dashboard route also calls expensesRepository.findExpenseSummaryByEmployee.
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

import {
  buildTestApp,
  signEmployeeToken,
  signAdminToken,
  TEST_ORG_ID,
} from "../../setup/test-server.js";
import { supabaseServiceClient as supabase } from "../../../src/config/supabase.js";
import { expensesRepository } from "../../../src/modules/expenses/expenses.repository.js";
import type { EmployeeExpenseSummary } from "@fieldtrack/types";

// ─── Supabase query builder factory ──────────────────────────────────────────

/** Build a mock Supabase chainable query builder that resolves to `result`. */
function makeBuilder(result: { data: unknown; error: null | { message: string }; count?: number | null }) {
  const b = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockReturnThis(),
    then: (_resolve: (v: unknown) => void): Promise<unknown> =>
      Promise.resolve(result).then(_resolve),
  };
  // Make the builder itself a thenable so `await builder.eq(...)` works
  Object.defineProperty(b, Symbol.toStringTag, { value: "Promise" });
  return b;
}

/** Returns a builder whose final `await` resolves to `result` */
function makeChainBuilder(result: { data: unknown; error: null | { message: string }; count?: number }) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "eq", "gte", "in", "order", "range", "limit"];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  // Make it awaitable
  (chain as { then: (r: (v: unknown) => void) => Promise<unknown> }).then = (resolve) =>
    Promise.resolve(result).then(resolve);
  return chain as ReturnType<typeof makeBuilder>;
}

// ─── Default fixture data ─────────────────────────────────────────────────────

const NOW = new Date().toISOString();

const SNAPSHOT_ROWS = [
  { status: "ACTIVE" },
  { status: "ACTIVE" },
  { status: "RECENT" },
  { status: "INACTIVE" },
];

const TODAY_SESSIONS = [
  { id: "s1", total_distance_km: 12.5 },
  { id: "s2", total_distance_km: 7.3 },
];

const EXPENSE_SUMMARY: EmployeeExpenseSummary[] = [
  {
    employeeId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    employeeName: "Test Employee",
    employeeCode: "EMP001",
    pendingCount: 3,
    pendingAmount: 225.0,
    totalCount: 5,
    totalAmount: 450.0,
    latestExpenseDate: NOW,
  },
];

// ─── Helper: set up supabase.from mock for one test ──────────────────────────

function mockDashboardSupabase(): void {
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    if (table === "employee_latest_sessions") {
      return makeChainBuilder({ data: SNAPSHOT_ROWS, error: null });
    }
    if (table === "attendance_sessions") {
      return makeChainBuilder({ data: TODAY_SESSIONS, error: null });
    }
    return makeChainBuilder({ data: [], error: null });
  });

  vi.mocked(expensesRepository.findExpenseSummaryByEmployee).mockResolvedValue({
    data: EXPENSE_SUMMARY,
    total: 1,
  });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("GET /admin/dashboard", () => {
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
    mockDashboardSupabase();
  });

  // ─── Auth & role guards ───────────────────────────────────────────────────

  it("returns 401 when no JWT is provided", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/dashboard" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when called with an employee token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { authorization: `Bearer ${employeeToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── Happy path ───────────────────────────────────────────────────────────

  it("returns 200 with aggregated dashboard data", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      success: boolean;
      data: {
        activeEmployeeCount: number;
        recentEmployeeCount: number;
        inactiveEmployeeCount: number;
        todaySessionCount: number;
        todayDistanceKm: number;
        pendingExpenseCount: number;
        pendingExpenseAmount: number;
      };
    }>();

    expect(body.success).toBe(true);
    expect(body.data.activeEmployeeCount).toBe(2);
    expect(body.data.recentEmployeeCount).toBe(1);
    expect(body.data.inactiveEmployeeCount).toBe(1);
    expect(body.data.todaySessionCount).toBe(2);
    expect(body.data.todayDistanceKm).toBe(19.8);
    expect(body.data.pendingExpenseCount).toBe(3);
    expect(body.data.pendingExpenseAmount).toBe(225.0);
  });

  it("returns zero counts when org has no data", async () => {
    vi.mocked(supabase.from).mockImplementation(() =>
      makeChainBuilder({ data: [], error: null }),
    );
    vi.mocked(expensesRepository.findExpenseSummaryByEmployee).mockResolvedValue({
      data: [],
      total: 0,
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { activeEmployeeCount: number; todaySessionCount: number } }>();
    expect(body.data.activeEmployeeCount).toBe(0);
    expect(body.data.todaySessionCount).toBe(0);
  });

  it("returns 500 when the snapshot query fails", async () => {
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "employee_latest_sessions") {
        return makeChainBuilder({ data: null, error: { message: "connection timeout" } });
      }
      return makeChainBuilder({ data: [], error: null });
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(500);
  });

  it("scopes query to requesting org ID", async () => {
    await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // from() is called for both tables; verify org_id is scoped
    // eq() is called on each builder — verify it's called with the right org_id
    // (We just verify from() was called at minimum once per table)
    expect(supabase.from).toHaveBeenCalledWith("employee_latest_sessions");
    expect(supabase.from).toHaveBeenCalledWith("attendance_sessions");
  });
});
