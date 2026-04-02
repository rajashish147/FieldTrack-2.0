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

vi.mock("../../../src/modules/admin/monitoring.repository.js", () => ({
  monitoringRepository: {
    getActiveSession: vi.fn(),
    startSession: vi.fn(),
    stopSession: vi.fn(),
    findHistory: vi.fn(),
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
  TEST_ADMIN_ID,
} from "../../setup/test-server.js";
import { monitoringRepository } from "../../../src/modules/admin/monitoring.repository.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const MONITORING_SESSION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const openMonitoringSession = {
  id: MONITORING_SESSION_ID,
  admin_id: TEST_ADMIN_ID,
  organization_id: TEST_ORG_ID,
  started_at: new Date().toISOString(),
  ended_at: null,
  created_at: new Date().toISOString(),
};

const closedMonitoringSession = {
  ...openMonitoringSession,
  ended_at: new Date().toISOString(),
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Admin Monitoring Integration Tests", () => {
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
    // Default: no active session, so startMonitoring proceeds to startSession
    vi.mocked(monitoringRepository.getActiveSession).mockResolvedValue(null);
  });

  // ─── POST /admin/start-monitoring ────────────────────────────────────────────

  describe("POST /admin/start-monitoring", () => {
    it("returns 401 when no JWT is provided", async () => {
      const res = await app.inject({ method: "POST", url: "/admin/start-monitoring" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 when called by an EMPLOYEE", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/admin/start-monitoring",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 201 with new session when ADMIN starts monitoring", async () => {
      vi.mocked(monitoringRepository.startSession).mockResolvedValue(
        openMonitoringSession as never,
      );

      const res = await app.inject({
        method: "POST",
        url: "/admin/start-monitoring",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as {
        success: boolean;
        data: typeof openMonitoringSession;
      };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(MONITORING_SESSION_ID);
      expect(body.data.ended_at).toBeNull();
    });

    it("calls repository startSession once", async () => {
      vi.mocked(monitoringRepository.startSession).mockResolvedValue(
        openMonitoringSession as never,
      );

      await app.inject({
        method: "POST",
        url: "/admin/start-monitoring",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(monitoringRepository.startSession).toHaveBeenCalledOnce();
    });
  });

  // ─── POST /admin/stop-monitoring ─────────────────────────────────────────────

  describe("POST /admin/stop-monitoring", () => {
    it("returns 401 when no JWT is provided", async () => {
      const res = await app.inject({ method: "POST", url: "/admin/stop-monitoring" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 when called by an EMPLOYEE", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/admin/stop-monitoring",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 200 with closed session when ADMIN stops monitoring", async () => {
      vi.mocked(monitoringRepository.stopSession).mockResolvedValue(
        closedMonitoringSession as never,
      );

      const res = await app.inject({
        method: "POST",
        url: "/admin/stop-monitoring",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        success: boolean;
        data: typeof closedMonitoringSession;
      };
      expect(body.success).toBe(true);
      expect(body.data.ended_at).not.toBeNull();
    });

    it("returns 404 when no active session exists to stop", async () => {
      vi.mocked(monitoringRepository.stopSession).mockResolvedValue(null);

      const res = await app.inject({
        method: "POST",
        url: "/admin/stop-monitoring",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error.toLowerCase()).toContain("active monitoring session");
    });
  });

  // ─── GET /admin/monitoring-history ───────────────────────────────────────────

  describe("GET /admin/monitoring-history", () => {
    it("returns 401 when no JWT is provided", async () => {
      const res = await app.inject({ method: "GET", url: "/admin/monitoring-history" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 when called by an EMPLOYEE", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/monitoring-history",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 200 with history list for ADMIN", async () => {
      vi.mocked(monitoringRepository.findHistory).mockResolvedValue({
        data: [closedMonitoringSession],
        total: 1,
      } as never);

      const res = await app.inject({
        method: "GET",
        url: "/admin/monitoring-history",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(1);
    });

    it("returns 200 with empty list when no history exists", async () => {
      vi.mocked(monitoringRepository.findHistory).mockResolvedValue({ data: [], total: 0 } as never);

      const res = await app.inject({
        method: "GET",
        url: "/admin/monitoring-history",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; data: unknown[] };
      expect(body.data).toHaveLength(0);
    });

    it("passes pagination params to the repository", async () => {
      vi.mocked(monitoringRepository.findHistory).mockResolvedValue({ data: [], total: 0 } as never);

      await app.inject({
        method: "GET",
        url: "/admin/monitoring-history?page=2&limit=5",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(monitoringRepository.findHistory).toHaveBeenCalledWith(
        expect.anything(),
        2,
        5,
      );
    });

    it("returns 400 for limit above 100", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/monitoring-history?limit=999",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
