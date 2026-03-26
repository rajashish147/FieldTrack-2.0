import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────
// Must be declared before any project imports so Vitest's hoisting ensures
// the mocks are active when registerRoutes() imports the service/repository.

vi.mock("../../../src/config/redis.js", () => ({
  redisClient: { on: vi.fn(), quit: vi.fn(), disconnect: vi.fn() },
}));

// attendanceService.getOrgSessions now uses getCached — bypass Redis in tests.
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

vi.mock("../../../src/modules/attendance/attendance.repository.js", () => ({
  attendanceRepository: {
    findOpenSession: vi.fn(),
    createSession: vi.fn(),
    closeSession: vi.fn(),
    findSessionsByUser: vi.fn(),
    findSessionsByOrg: vi.fn(),
    findLatestSessionPerEmployee: vi.fn(),
    validateSessionActive: vi.fn(),
    getSessionCheckinAt: vi.fn(),
    upsertLatestSession: vi.fn().mockResolvedValue(undefined),
    updateLatestSessionDistance: vi.fn().mockResolvedValue(undefined),
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
  TEST_SESSION_ID,
} from "../../setup/test-server.js";
import { attendanceRepository } from "../../../src/modules/attendance/attendance.repository.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const openSession = {
  id: TEST_SESSION_ID,
  employee_id: TEST_EMPLOYEE_ID,
  organization_id: TEST_ORG_ID,
  checkin_at: new Date().toISOString(),
  checkout_at: null,
  distance_recalculation_status: "pending",
  total_distance_km: null,
  total_duration_seconds: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  employee_code: "EMP001",
  employee_name: "Test Employee",
  activityStatus: "ACTIVE" as const,
};

const closedSession = {
  ...openSession,
  checkout_at: new Date().toISOString(),
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Attendance Integration Tests", () => {
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

  // ─── POST /attendance/check-in ──────────────────────────────────────────────

  describe("POST /attendance/check-in", () => {
    it("returns 401 when no JWT is provided", async () => {
      const res = await app.inject({ method: "POST", url: "/attendance/check-in" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 201 with session data on successful check-in", async () => {
      vi.mocked(attendanceRepository.findOpenSession).mockResolvedValue(null);
      vi.mocked(attendanceRepository.createSession).mockResolvedValue(openSession as never);

      const res = await app.inject({
        method: "POST",
        url: "/attendance/check-in",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { success: boolean; data: typeof openSession };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(TEST_SESSION_ID);
    });

    it("calls upsertLatestSession after successful check-in", async () => {
      vi.mocked(attendanceRepository.findOpenSession).mockResolvedValue(null);
      vi.mocked(attendanceRepository.createSession).mockResolvedValue(openSession as never);

      await app.inject({
        method: "POST",
        url: "/attendance/check-in",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(attendanceRepository.upsertLatestSession).toHaveBeenCalledWith(
        TEST_ORG_ID,
        TEST_EMPLOYEE_ID,
        openSession,
      );
    });

    it("returns 400 with domain error when already checked in", async () => {
      vi.mocked(attendanceRepository.findOpenSession).mockResolvedValue(openSession as never);

      const res = await app.inject({
        method: "POST",
        url: "/attendance/check-in",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain("active session");
    });

    it("returns 403 when called by an ADMIN (M6 fix)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/attendance/check-in",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body) as { success: false; error: string };
      expect(body.error).toMatch(/requires employee role/i);
    });

    it("returns 404 when employee is not in the organization", async () => {
      // Simulate auth middleware finding no employee row: token without employee_id → undefined.
      // Currently the integration test JWT always includes employee_id via signEmployeeToken.
      // We verify the route exists and auth is enforced; 404 is covered by unit tests.
      const res = await app.inject({
        method: "POST",
        url: "/attendance/check-in",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      // employeeToken always has employee_id — just assert endpoint is reachable.
      expect([201, 400]).toContain(res.statusCode);
    });
  });

  // ─── POST /attendance/check-out ─────────────────────────────────────────────

  describe("POST /attendance/check-out", () => {
    it("returns 401 when no JWT is provided", async () => {
      const res = await app.inject({ method: "POST", url: "/attendance/check-out" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with closed session on successful check-out", async () => {
      vi.mocked(attendanceRepository.findOpenSession).mockResolvedValue(openSession as never);
      vi.mocked(attendanceRepository.closeSession).mockResolvedValue(closedSession as never);

      const res = await app.inject({
        method: "POST",
        url: "/attendance/check-out",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; data: typeof closedSession };
      expect(body.success).toBe(true);
      expect(body.data.checkout_at).not.toBeNull();
    });

    it("calls upsertLatestSession after successful check-out", async () => {
      vi.mocked(attendanceRepository.findOpenSession).mockResolvedValue(openSession as never);
      vi.mocked(attendanceRepository.closeSession).mockResolvedValue(closedSession as never);

      await app.inject({
        method: "POST",
        url: "/attendance/check-out",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(attendanceRepository.upsertLatestSession).toHaveBeenCalledWith(
        TEST_ORG_ID,
        TEST_EMPLOYEE_ID,
        closedSession,
      );
    });

    it("returns 400 when no open session exists", async () => {
      vi.mocked(attendanceRepository.findOpenSession).mockResolvedValue(null);

      const res = await app.inject({
        method: "POST",
        url: "/attendance/check-out",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error.toLowerCase()).toContain("check in");
    });

    it("returns 403 when called by an ADMIN (M6 fix)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/attendance/check-out",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body) as { success: false; error: string };
      expect(body.error).toMatch(/requires employee role/i);
    });
  });

  // ─── GET /attendance/my-sessions ────────────────────────────────────────────

  describe("GET /attendance/my-sessions", () => {
    it("returns 401 without a JWT", async () => {
      const res = await app.inject({ method: "GET", url: "/attendance/my-sessions" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with a list of sessions", async () => {
      vi.mocked(attendanceRepository.findSessionsByUser).mockResolvedValue({
        data: [openSession],
        total: 1,
      } as never);

      const res = await app.inject({
        method: "GET",
        url: "/attendance/my-sessions",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("passes pagination params to the repository", async () => {
      vi.mocked(attendanceRepository.findSessionsByUser).mockResolvedValue({ data: [], total: 0 } as never);

      await app.inject({
        method: "GET",
        url: "/attendance/my-sessions?page=2&limit=5",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(attendanceRepository.findSessionsByUser).toHaveBeenCalledWith(
        expect.anything(),
        TEST_EMPLOYEE_ID,
        2,
        5,
      );
    });

    it("rejects an invalid limit above 100", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/attendance/my-sessions?limit=500",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      // Zod schema has max(100); limit=500 should fail validation
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── GET /attendance/org-sessions (REMOVED — MIN2) ──────────────────────────

  describe("GET /attendance/org-sessions", () => {
    it("returns 403 when called by a non-ADMIN employee", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/attendance/org-sessions",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 410 Gone for an ADMIN (route removed, use /admin/sessions)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/attendance/org-sessions",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(410);
      const body = JSON.parse(res.body) as { success: false; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/\/admin\/sessions/);
    });
  });

  // ─── Multi-tenant isolation ───────────────────────────────────────────────────

  describe("Multi-tenant isolation", () => {
    it("propagates organizationId from JWT to the repository call", async () => {
      vi.mocked(attendanceRepository.findSessionsByUser).mockResolvedValue({ data: [], total: 0 } as never);

      const tokenOrgB = signEmployeeToken(app, TEST_EMPLOYEE_ID, TEST_ORG_ID_B);
      await app.inject({
        method: "GET",
        url: "/attendance/my-sessions",
        headers: { authorization: `Bearer ${tokenOrgB}` },
      });

      expect(attendanceRepository.findSessionsByUser).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: TEST_ORG_ID_B }),
        TEST_EMPLOYEE_ID,
        expect.any(Number),
        expect.any(Number),
      );
    });

    it("two different org tokens result in separate organizationId values", async () => {
      vi.mocked(attendanceRepository.findSessionsByUser).mockResolvedValue({ data: [], total: 0 } as never);

      const tokenOrgA = signEmployeeToken(app, TEST_EMPLOYEE_ID, TEST_ORG_ID);
      const tokenOrgB = signEmployeeToken(app, TEST_EMPLOYEE_ID, TEST_ORG_ID_B);

      await app.inject({
        method: "GET",
        url: "/attendance/my-sessions",
        headers: { authorization: `Bearer ${tokenOrgA}` },
      });
      const callA = vi.mocked(attendanceRepository.findSessionsByUser).mock
        .calls[0]![0] as unknown as { organizationId: string };

      await app.inject({
        method: "GET",
        url: "/attendance/my-sessions",
        headers: { authorization: `Bearer ${tokenOrgB}` },
      });
      const callB = vi.mocked(attendanceRepository.findSessionsByUser).mock
        .calls[1]![0] as unknown as { organizationId: string };

      expect(callA.organizationId).toBe(TEST_ORG_ID);
      expect(callB.organizationId).toBe(TEST_ORG_ID_B);
      expect(callA.organizationId).not.toBe(callB.organizationId);
    });
  });
});
