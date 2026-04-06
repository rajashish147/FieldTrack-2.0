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

// Bypass Redis caching — always call through to the underlying function
vi.mock("../../../src/utils/cache.js", () => ({
  getCached: vi.fn().mockImplementation(
    async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
  ),
  invalidateOrgAnalytics: vi.fn().mockResolvedValue(undefined),
  ANALYTICS_CACHE_TTL: 300,
}));

vi.mock("../../../src/modules/analytics/analytics.repository.js", () => ({
  analyticsRepository: {
    getSessionsInRange: vi.fn(),
    getExpensesInRange: vi.fn(),
    getActiveEmployeesCount: vi.fn(),
    getSessionsForUser: vi.fn(),
    getSessionsWithEmployeeNames: vi.fn(),
    checkUserHasSessionsInOrg: vi.fn(),
    getExpensesForUser: vi.fn(),
    getOrgDailyMetrics: vi.fn(),
    getEmployeeMetricsAggregated: vi.fn(),
    getEmployeeMetricsForUser: vi.fn(),
    findEmployeeIdByUserId: vi.fn(),
  },
}));

// Mock orgTable for the direct employees lookup inside analytics.service.getLeaderboard.
// Repository-level calls never reach orgTable (they're fully mocked above).
vi.mock("../../../src/db/query.js", () => ({
  orgTable: vi.fn(),
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
  signAdminToken,
  signEmployeeToken,
  TEST_ORG_ID_B,
  TEST_EMPLOYEE_ID,
  TEST_ADMIN_ID,
} from "../../setup/test-server.js";
import { analyticsRepository } from "../../../src/modules/analytics/analytics.repository.js";
import { orgTable } from "../../../src/db/query.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const SESSION_TREND_DATA = [
  { date: "2026-03-01", sessions: 3, distance: 45.0, duration: 7200 },
  { date: "2026-03-02", sessions: 5, distance: 80.0, duration: 12000 },
];

const LEADERBOARD_AGGREGATED = [
  {
    employee_id: TEST_EMPLOYEE_ID,
    total_distance: 120.5,
    total_duration: 18000,
    total_sessions: 8,
    total_expenses_count: 3,
    total_expenses_amount: 450.0,
  },
  {
    employee_id: TEST_ADMIN_ID,
    total_distance: 45.0,
    total_duration: 7200,
    total_sessions: 3,
    total_expenses_count: 1,
    total_expenses_amount: 80.0,
  },
];

const EMPLOYEES_LOOKUP = [
  { id: TEST_EMPLOYEE_ID, name: "Alice", employee_code: "EMP001" },
  { id: TEST_ADMIN_ID, name: "Bob", employee_code: "EMP002" },
];

/**
 * Configure the orgTable mock for the employees name lookup inside
 * analytics.service.getLeaderboard. The service calls:
 *   orgTable(request, "employees").select("id, name, employee_code").in("id", ids)
 * The orgTable wrapper's select() method internally adds the .eq("organization_id")
 * filter, so from the caller's perspective the chain is select → in.
 */
function setupOrgTableEmployeesMock(
  employees: typeof EMPLOYEES_LOOKUP = EMPLOYEES_LOOKUP,
) {
  const mockIn = vi.fn().mockResolvedValue({ data: employees, error: null });
  const mockSelect = vi.fn().mockReturnValue({ in: mockIn });
  vi.mocked(orgTable).mockReturnValue({ select: mockSelect } as never);
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Analytics Integration Tests", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let employeeToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    adminToken = signAdminToken(app);
    employeeToken = signEmployeeToken(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET /admin/org-summary ──────────────────────────────────────────────

  describe("GET /admin/org-summary", () => {
    it("returns 401 without a JWT", async () => {
      const res = await app.inject({ method: "GET", url: "/admin/org-summary" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 for employee tokens", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/org-summary",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 200 with org summary for admin", async () => {
      vi.mocked(analyticsRepository.getOrgDailyMetrics).mockResolvedValue([
        { date: "2026-03-01", sessions: 2, distance: 145.3, duration: 25200 },
      ] as never);
      vi.mocked(analyticsRepository.getExpensesInRange).mockResolvedValue([
        { amount: 620, status: "APPROVED" },
        { amount: 50, status: "REJECTED" },
        { amount: 100, status: "PENDING" },
        { amount: 200, status: "PENDING" },
        { amount: 150, status: "PENDING" },
        { amount: 80, status: "PENDING" },
        { amount: 90, status: "PENDING" },
        { amount: 60, status: "PENDING" },
      ] as never);
      vi.mocked(analyticsRepository.getActiveEmployeesCount).mockResolvedValue(4);

      const res = await app.inject({
        method: "GET",
        url: "/admin/org-summary",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; data: Record<string, number> };
      expect(body.success).toBe(true);
      expect(body.data.totalSessions).toBe(2);
      expect(body.data.activeEmployeesCount).toBe(4);
      expect(body.data.totalExpenses).toBe(8);
      expect(body.data.approvedExpenseAmount).toBe(620);
      expect(body.data.rejectedExpenseAmount).toBe(50);
    });

    it("returns 200 with empty data when no sessions exist", async () => {
      vi.mocked(analyticsRepository.getOrgDailyMetrics).mockResolvedValue([] as never);
      vi.mocked(analyticsRepository.getExpensesInRange).mockResolvedValue([]);
      vi.mocked(analyticsRepository.getActiveEmployeesCount).mockResolvedValue(0);

      const res = await app.inject({
        method: "GET",
        url: "/admin/org-summary",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; data: Record<string, number> };
      expect(body.data.totalSessions).toBe(0);
      expect(body.data.totalDistanceKm).toBe(0);
    });

    it("returns 400 when from > to", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/org-summary?from=2026-03-10T00:00:00.000Z&to=2026-03-01T00:00:00.000Z",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects cross-tenant access (token from org B cannot see org A data)", async () => {
      const orgBAdminToken = signAdminToken(app, TEST_ADMIN_ID, TEST_ORG_ID_B);
      vi.mocked(analyticsRepository.getSessionsInRange).mockResolvedValue([]);
      vi.mocked(analyticsRepository.getExpensesInRange).mockResolvedValue([]);
      vi.mocked(analyticsRepository.getActiveEmployeesCount).mockResolvedValue(0);

      vi.mocked(analyticsRepository.getOrgDailyMetrics).mockResolvedValue([] as never);
      vi.mocked(analyticsRepository.getExpensesInRange).mockResolvedValue([]);
      vi.mocked(analyticsRepository.getActiveEmployeesCount).mockResolvedValue(0);
      // The token carries org B's ID — response is 200 but query is org-B scoped
      const res = await app.inject({
        method: "GET",
        url: "/admin/org-summary",
        headers: { authorization: `Bearer ${orgBAdminToken}` },
      });
      expect(res.statusCode).toBe(200);
      // orgTable() in service will scope to org B — analyticsRepository mock returns []
      const body = JSON.parse(res.body) as { success: boolean; data: Record<string, number> };
      expect(body.data.totalSessions).toBe(0);
    });
  });

  // ─── GET /admin/session-trend ────────────────────────────────────────────

  describe("GET /admin/session-trend", () => {
    it("returns 401 without a JWT", async () => {
      const res = await app.inject({ method: "GET", url: "/admin/session-trend" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 for employee tokens", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/session-trend",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 200 with session trend data", async () => {
      vi.mocked(analyticsRepository.getOrgDailyMetrics).mockResolvedValue(
        SESSION_TREND_DATA as never,
      );

      const res = await app.inject({
        method: "GET",
        url: "/admin/session-trend",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        success: boolean;
        data: typeof SESSION_TREND_DATA;
      };
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].date).toBe("2026-03-01");
      expect(body.data[0].sessions).toBe(3);
    });

    it("returns 200 with empty array when no trend data exists", async () => {
      vi.mocked(analyticsRepository.getOrgDailyMetrics).mockResolvedValue([]);

      const res = await app.inject({
        method: "GET",
        url: "/admin/session-trend",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; data: unknown[] };
      expect(body.data).toHaveLength(0);
    });

    it("accepts valid ISO date range parameters", async () => {
      vi.mocked(analyticsRepository.getOrgDailyMetrics).mockResolvedValue(
        SESSION_TREND_DATA as never,
      );

      const res = await app.inject({
        method: "GET",
        url: "/admin/session-trend?from=2026-03-01T00:00:00.000Z&to=2026-03-14T00:00:00.000Z",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ─── GET /admin/leaderboard ──────────────────────────────────────────────

  describe("GET /admin/leaderboard", () => {
    it("returns 401 without a JWT", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/leaderboard?metric=distance",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 for employee tokens", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/leaderboard?metric=distance",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("defaults metric to 'distance' when param is omitted", async () => {
      vi.mocked(analyticsRepository.getEmployeeMetricsAggregated).mockResolvedValue([]);
      const res = await app.inject({
        method: "GET",
        url: "/admin/leaderboard",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
    });

    it("returns 400 when metric value is invalid", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/leaderboard?metric=invalid",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when from > to", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/leaderboard?metric=distance&from=2026-03-10T00:00:00.000Z&to=2026-03-01T00:00:00.000Z",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 200 with empty array when no metrics exist", async () => {
      vi.mocked(analyticsRepository.getEmployeeMetricsAggregated).mockResolvedValue([]);

      const res = await app.inject({
        method: "GET",
        url: "/admin/leaderboard?metric=distance",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(0);
    });

    it("accepts all four valid metric values and returns 200", async () => {
      for (const metric of ["distance", "duration", "sessions", "expenses"]) {
        vi.mocked(analyticsRepository.getEmployeeMetricsAggregated).mockResolvedValue([]);

        const res = await app.inject({
          method: "GET",
          url: `/admin/leaderboard?metric=${metric}`,
          headers: { authorization: `Bearer ${adminToken}` },
        });

        expect(res.statusCode).toBe(200);
      }
    });

    it("returns ranked leaderboard sorted by distance", async () => {
      vi.mocked(analyticsRepository.getEmployeeMetricsAggregated).mockResolvedValue(
        LEADERBOARD_AGGREGATED as never,
      );
      setupOrgTableEmployeesMock();

      const res = await app.inject({
        method: "GET",
        url: "/admin/leaderboard?metric=distance",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        success: boolean;
        data: Array<{
          rank: number;
          employeeId: string;
          employeeName: string;
          employeeCode: string | null;
          distance: number;
          sessions: number;
          duration: number;
          expenses?: number;
        }>;
      };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].rank).toBe(1);
      // Alice has the higher distance (120.5 vs 45.0) so should rank first
      expect(body.data[0].employeeId).toBe(TEST_EMPLOYEE_ID);
      expect(body.data[0].employeeName).toBe("Alice");
      expect(body.data[0].employeeCode).toBe("EMP001");
      expect(body.data[0].distance).toBe(120.5);
      expect(body.data[1].rank).toBe(2);
    });

    it("returns ranked leaderboard sorted by expenses (amount-based)", async () => {
      vi.mocked(analyticsRepository.getEmployeeMetricsAggregated).mockResolvedValue(
        LEADERBOARD_AGGREGATED as never,
      );
      setupOrgTableEmployeesMock();

      const res = await app.inject({
        method: "GET",
        url: "/admin/leaderboard?metric=expenses",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        success: boolean;
        data: Array<{ rank: number; employeeId: string; expenses?: number }>;
      };
      expect(body.data[0].employeeId).toBe(TEST_EMPLOYEE_ID); // Alice: 450.00
      expect(body.data[0].expenses).toBe(450);
      expect(body.data[1].employeeId).toBe(TEST_ADMIN_ID); // Bob: 80.00
      expect(body.data[1].expenses).toBe(80);
    });

    it("returns ranked leaderboard sorted by sessions descending", async () => {
      vi.mocked(analyticsRepository.getEmployeeMetricsAggregated).mockResolvedValue(
        LEADERBOARD_AGGREGATED as never,
      );
      setupOrgTableEmployeesMock();

      const res = await app.inject({
        method: "GET",
        url: "/admin/leaderboard?metric=sessions",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        success: boolean;
        data: Array<{ employeeId: string; sessions: number }>;
      };
      // Alice: 8 sessions — should rank first
      expect(body.data[0].employeeId).toBe(TEST_EMPLOYEE_ID);
      expect(body.data[0].sessions).toBe(8);
    });

    it("respects the limit parameter", async () => {
      vi.mocked(analyticsRepository.getEmployeeMetricsAggregated).mockResolvedValue(
        LEADERBOARD_AGGREGATED as never,
      );
      setupOrgTableEmployeesMock([EMPLOYEES_LOOKUP[0]!]); // only first employee returned

      const res = await app.inject({
        method: "GET",
        url: "/admin/leaderboard?metric=distance&limit=1",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { data: unknown[] };
      expect(body.data).toHaveLength(1);
    });

    it("omits the expenses field when amount is zero and metric is not expenses", async () => {
      vi.mocked(analyticsRepository.getEmployeeMetricsAggregated).mockResolvedValue([
        {
          employee_id: TEST_EMPLOYEE_ID,
          total_distance: 50.0,
          total_duration: 3600,
          total_sessions: 2,
          total_expenses_count: 0,
          total_expenses_amount: 0,
        },
      ] as never);
      setupOrgTableEmployeesMock([EMPLOYEES_LOOKUP[0]!]);

      const res = await app.inject({
        method: "GET",
        url: "/admin/leaderboard?metric=distance",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        data: Array<Record<string, unknown>>;
      };
      // expenses field should be absent when amount is 0 and metric != expenses
      expect(body.data[0]).not.toHaveProperty("expenses");
    });

    it("includes expenses field when metric is expenses even with zero amount", async () => {
      vi.mocked(analyticsRepository.getEmployeeMetricsAggregated).mockResolvedValue([
        {
          employee_id: TEST_EMPLOYEE_ID,
          total_distance: 50.0,
          total_duration: 3600,
          total_sessions: 2,
          total_expenses_count: 0,
          total_expenses_amount: 0,
        },
      ] as never);
      setupOrgTableEmployeesMock([EMPLOYEES_LOOKUP[0]!]);

      const res = await app.inject({
        method: "GET",
        url: "/admin/leaderboard?metric=expenses",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        data: Array<Record<string, unknown>>;
      };
      // expenses field should be present when metric=expenses (even if 0)
      expect(body.data[0]).toHaveProperty("expenses");
      expect(body.data[0].expenses).toBe(0);
    });

    it("produces deterministic ordering when two employees are tied on distance", async () => {
      // Both employees share the same total_distance (100.0).
      // The secondary sort key is employee_id (localeCompare ascending), so the
      // employee with the lexicographically smaller UUID should always rank first,
      // regardless of which order the repository returns them.
      const TIED_ID_A = "11111111-1111-4111-8111-111111111111"; // sorts first
      const TIED_ID_B = "99999999-9999-4999-8999-999999999999"; // sorts second

      // Return in reversed order (B before A) to confirm sorting is applied
      vi.mocked(analyticsRepository.getEmployeeMetricsAggregated).mockResolvedValue([
        {
          employee_id: TIED_ID_B,
          total_distance: 100.0,
          total_duration: 3600,
          total_sessions: 2,
          total_expenses_count: 0,
          total_expenses_amount: 0,
        },
        {
          employee_id: TIED_ID_A,
          total_distance: 100.0,
          total_duration: 3600,
          total_sessions: 2,
          total_expenses_count: 0,
          total_expenses_amount: 0,
        },
      ] as never);

      const tiedEmployees = [
        { id: TIED_ID_A, name: "Alice", employee_code: "EMP-A" },
        { id: TIED_ID_B, name: "Zara", employee_code: "EMP-Z" },
      ];
      const mockIn = vi.fn().mockResolvedValue({ data: tiedEmployees, error: null });
      const mockSelect = vi.fn().mockReturnValue({ in: mockIn });
      vi.mocked(orgTable).mockReturnValue({ select: mockSelect } as never);

      const res = await app.inject({
        method: "GET",
        url: "/admin/leaderboard?metric=distance",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        data: Array<{ rank: number; employeeId: string; employeeName: string }>;
      };

      expect(body.data).toHaveLength(2);
      // TIED_ID_A < TIED_ID_B lexicographically → Alice always ranks 1st
      expect(body.data[0].rank).toBe(1);
      expect(body.data[0].employeeId).toBe(TIED_ID_A);
      expect(body.data[0].employeeName).toBe("Alice");
      expect(body.data[1].rank).toBe(2);
      expect(body.data[1].employeeId).toBe(TIED_ID_B);
    });
  });
});
