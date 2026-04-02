import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../../../src/config/redis.js", () => ({
  redisClient: { on: vi.fn(), quit: vi.fn(), disconnect: vi.fn() },
}));

// Phase 22/24: Dashboard route uses getCached(). Mock it to call fn() directly
// so tests never attempt a Redis connection.
vi.mock("../../../src/utils/cache.js", () => ({
  getCached: vi.fn().mockImplementation(
    (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
  ),
  invalidateOrgAnalytics: vi.fn().mockResolvedValue(undefined),
  ANALYTICS_CACHE_TTL: 300,
}));

vi.mock("../../../src/workers/distance.queue.js", () => ({
  enqueueDistanceJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/workers/analytics.queue.js", () => ({
  enqueueAnalyticsJob: vi.fn().mockResolvedValue(undefined),
}));

// Phase 24: Dashboard route now calls supabaseServiceClient.from("org_dashboard_snapshot").
vi.mock("../../../src/config/supabase.js", () => ({
  supabaseServiceClient: { from: vi.fn() },
}));

// Stub the analytics service so the dashboard test does not hit Redis.
vi.mock("../../../src/modules/analytics/analytics.service.js", () => ({
  analyticsService: {
    getSessionTrend: vi.fn().mockResolvedValue([]),
    getLeaderboard:  vi.fn().mockResolvedValue([]),
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
} from "../../setup/test-server.js";
import { supabaseServiceClient as supabase } from "../../../src/config/supabase.js";

// ─── Supabase query builder factory ──────────────────────────────────────────

/** Build a mock Supabase chainable query builder that resolves to `result`. */
function makeChainBuilder(result: { data: unknown; error: null | { message: string }; count?: number | null }) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "eq", "gte", "in", "order", "range", "limit"];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  // Make it awaitable (for direct-await usage)
  (chain as { then: (r: (v: unknown) => void) => Promise<unknown> }).then = (resolve) =>
    Promise.resolve(result).then(resolve);
  // Support .maybeSingle() terminal call (used by org_dashboard_snapshot)
  (chain as { maybeSingle: () => Promise<unknown> }).maybeSingle = () =>
    Promise.resolve(result);
  return chain as ReturnType<typeof makeChainBuilder>;
}

// ─── Default fixture data ─────────────────────────────────────────────────────

// Phase 24: dashboard reads a single row from org_dashboard_snapshot.
const DEFAULT_SNAPSHOT = {
  active_employee_count:   2,
  recent_employee_count:   1,
  inactive_employee_count: 1,
  active_employees_today:  2,
  today_session_count:     2,
  today_distance_km:       19.8,
  pending_expense_count:   3,
  pending_expense_amount:  225.0,
};

// ─── Helper: set up supabase.from mock for one test ──────────────────────────

function mockDashboardSupabase(
  snapData: typeof DEFAULT_SNAPSHOT | null = DEFAULT_SNAPSHOT,
  snapError: { message: string } | null = null,
): void {
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    if (table === "org_dashboard_snapshot") {
      return makeChainBuilder({ data: snapData, error: snapError });
    }
    return makeChainBuilder({ data: [], error: null });
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

  it("returns 200 with aggregated dashboard data from snapshot", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      success: boolean;
      data: {
        activeEmployeeCount:   number;
        recentEmployeeCount:   number;
        inactiveEmployeeCount: number;
        activeEmployeesToday:  number;
        todaySessionCount:     number;
        todayDistanceKm:       number;
        pendingExpenseCount:   number;
        pendingExpenseAmount:  number;
        sessionTrend:  unknown[];
        leaderboard:   unknown[];
      };
    }>();

    expect(body.success).toBe(true);
    expect(body.data.activeEmployeeCount).toBe(2);
    expect(body.data.recentEmployeeCount).toBe(1);
    expect(body.data.inactiveEmployeeCount).toBe(1);
    expect(body.data.activeEmployeesToday).toBe(2);
    expect(body.data.todaySessionCount).toBe(2);
    expect(body.data.todayDistanceKm).toBe(19.8);
    expect(body.data.pendingExpenseCount).toBe(3);
    expect(body.data.pendingExpenseAmount).toBe(225.0);
    expect(Array.isArray(body.data.sessionTrend)).toBe(true);
    expect(Array.isArray(body.data.leaderboard)).toBe(true);
  });

  it("returns zero counts when org has no snapshot yet (null row)", async () => {
    // No snapshot row exists → maybeSingle returns null data — dashboard returns zeros.
    mockDashboardSupabase(null);

    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { activeEmployeeCount: number; todaySessionCount: number; pendingExpenseCount: number };
    }>();
    expect(body.data.activeEmployeeCount).toBe(0);
    expect(body.data.todaySessionCount).toBe(0);
    expect(body.data.pendingExpenseCount).toBe(0);
  });

  it("returns 500 when the snapshot query fails", async () => {
    mockDashboardSupabase(null, { message: "connection timeout" });

    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(500);
  });

  it("queries org_dashboard_snapshot (single O(1) lookup)", async () => {
    await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // Phase 24: only one table should be queried for the dashboard metrics.
    expect(supabase.from).toHaveBeenCalledWith("org_dashboard_snapshot");
    // Verify legacy multi-query tables are no longer called directly by the route.
    expect(supabase.from).not.toHaveBeenCalledWith("employee_latest_sessions");
    expect(supabase.from).not.toHaveBeenCalledWith("org_daily_metrics");
    expect(supabase.from).not.toHaveBeenCalledWith("expenses");
  });
});
