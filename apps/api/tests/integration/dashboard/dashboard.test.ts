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

// Dashboard service calls orgTable directly (no dedicated repository), so mock
// the service itself to prevent any DB calls in integration tests.
vi.mock("../../../src/modules/dashboard/dashboard.service.js", () => ({
  dashboardService: {
    getMySummary: vi.fn(),
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
import { dashboardService } from "../../../src/modules/dashboard/dashboard.service.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const employeeSummary = {
  sessionsThisWeek: 3,
  distanceThisWeek: 42.5,
  hoursThisWeek: 8.25,
  expensesSubmitted: 2,
  expensesApproved: 1,
};

const zeroSummary = {
  sessionsThisWeek: 0,
  distanceThisWeek: 0,
  hoursThisWeek: 0,
  expensesSubmitted: 0,
  expensesApproved: 0,
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Dashboard Integration Tests", () => {
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

  // ─── GET /dashboard/my-summary ───────────────────────────────────────────────

  describe("GET /dashboard/my-summary", () => {
    it("returns 401 when no JWT is provided", async () => {
      const res = await app.inject({ method: "GET", url: "/dashboard/my-summary" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with employee dashboard summary", async () => {
      vi.mocked(dashboardService.getMySummary).mockResolvedValue(employeeSummary as never);

      const res = await app.inject({
        method: "GET",
        url: "/dashboard/my-summary",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        success: boolean;
        data: typeof employeeSummary;
      };
      expect(body.success).toBe(true);
      expect(body.data.sessionsThisWeek).toBe(3);
      expect(body.data.distanceThisWeek).toBe(42.5);
      expect(body.data.hoursThisWeek).toBe(8.25);
      expect(body.data.expensesSubmitted).toBe(2);
      expect(body.data.expensesApproved).toBe(1);
    });

    it("returns 200 with zero summary for ADMIN without employee record", async () => {
      vi.mocked(dashboardService.getMySummary).mockResolvedValue(zeroSummary as never);

      const res = await app.inject({
        method: "GET",
        url: "/dashboard/my-summary",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; data: typeof zeroSummary };
      expect(body.success).toBe(true);
      expect(body.data.sessionsThisWeek).toBe(0);
      expect(body.data.expensesSubmitted).toBe(0);
    });

    it("returns a response with the correct DashboardSummary shape", async () => {
      vi.mocked(dashboardService.getMySummary).mockResolvedValue(employeeSummary as never);

      const res = await app.inject({
        method: "GET",
        url: "/dashboard/my-summary",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      const { data } = JSON.parse(res.body) as { data: Record<string, unknown> };
      expect(data).toHaveProperty("sessionsThisWeek");
      expect(data).toHaveProperty("distanceThisWeek");
      expect(data).toHaveProperty("hoursThisWeek");
      expect(data).toHaveProperty("expensesSubmitted");
      expect(data).toHaveProperty("expensesApproved");
    });

    it("calls the service once per request", async () => {
      vi.mocked(dashboardService.getMySummary).mockResolvedValue(zeroSummary as never);

      await app.inject({
        method: "GET",
        url: "/dashboard/my-summary",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(dashboardService.getMySummary).toHaveBeenCalledOnce();
    });
  });
});
