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

vi.mock("../../../src/modules/profile/profile.repository.js", () => ({
  profileRepository: {
    getEmployeeById: vi.fn(),
    getEmployeeStats: vi.fn(),
    getEmployeeExpenseStats: vi.fn(),
    getMetricsSnapshot: vi.fn().mockResolvedValue(null),
    updateLastActivity: vi.fn().mockResolvedValue(undefined),
  },
  computeActivityStatusFromTimestamp: vi.fn().mockReturnValue("ACTIVE"),
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
  TEST_ORG_ID,
  TEST_ORG_ID_B,
  TEST_EMPLOYEE_ID,
  TEST_ADMIN_ID,
} from "../../setup/test-server.js";
import { profileRepository } from "../../../src/modules/profile/profile.repository.js";

// ─── Valid URL-param UUIDs ─────────────────────────────────────────────────────
// TEST_EMPLOYEE_ID / TEST_ADMIN_ID don't satisfy Zod v4's strict RFC-4122 regex
// (version byte must be 1-8). Use explicit valid v4 UUIDs for /:employeeId params.
const VALID_EMPLOYEE_UUID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VALID_ADMIN_UUID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const EMPLOYEE_ROW = {
  id: VALID_EMPLOYEE_UUID,
  name: "Alice Smith",
  employee_code: "EMP001",
  phone: "+1234567890",
  is_active: true,
  last_activity_at: new Date(Date.now() - 3600_000).toISOString(), // 1h ago → ACTIVE
  created_at: "2026-01-01T00:00:00.000Z",
};

const ADMIN_ROW = {
  id: VALID_ADMIN_UUID,
  name: "Bob Admin",
  employee_code: "EMP002",
  phone: null,
  is_active: true,
  last_activity_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

const EMPLOYEE_STATS = {
  totalSessions: 12,
  totalDistanceKm: 148.5,
  totalDurationSeconds: 43200,
};

const EXPENSE_STATS = {
  expensesSubmitted: 5,
  expensesApproved: 3,
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Profile Integration Tests", () => {
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

  // ─── GET /profile/me ─────────────────────────────────────────────────────

  describe("GET /profile/me", () => {
    it("returns 401 without a JWT", async () => {
      const res = await app.inject({ method: "GET", url: "/profile/me" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with the employee's own profile", async () => {
      vi.mocked(profileRepository.getEmployeeById).mockResolvedValue(EMPLOYEE_ROW);
      vi.mocked(profileRepository.getEmployeeStats).mockResolvedValue(EMPLOYEE_STATS);
      vi.mocked(profileRepository.getEmployeeExpenseStats).mockResolvedValue(EXPENSE_STATS);

      const res = await app.inject({
        method: "GET",
        url: "/profile/me",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        success: boolean;
        data: {
          id: string;
          name: string;
          employee_code: string | null;
          phone: string | null;
          is_active: boolean;
          activityStatus: string;
          last_activity_at: string | null;
          created_at: string;
          stats: {
            totalSessions: number;
            totalDistanceKm: number;
            totalDurationSeconds: number;
            expensesSubmitted: number;
            expensesApproved: number;
          };
        };
      };

      expect(body.success).toBe(true);
      expect(body.data.id).toBe(VALID_EMPLOYEE_UUID);
      expect(body.data.name).toBe("Alice Smith");
      expect(body.data.employee_code).toBe("EMP001");
      expect(body.data.phone).toBe("+1234567890");
      expect(body.data.is_active).toBe(true);
      expect(body.data.activityStatus).toBe("ACTIVE");
      expect(body.data.stats.totalSessions).toBe(12);
      expect(body.data.stats.totalDistanceKm).toBe(148.5);
      expect(body.data.stats.totalDurationSeconds).toBe(43200);
      expect(body.data.stats.expensesSubmitted).toBe(5);
      expect(body.data.stats.expensesApproved).toBe(3);
    });

    it("fetches the requesting employee's own ID (not a different employee)", async () => {
      vi.mocked(profileRepository.getEmployeeById).mockResolvedValue(EMPLOYEE_ROW);
      vi.mocked(profileRepository.getEmployeeStats).mockResolvedValue(EMPLOYEE_STATS);
      vi.mocked(profileRepository.getEmployeeExpenseStats).mockResolvedValue(EXPENSE_STATS);

      await app.inject({
        method: "GET",
        url: "/profile/me",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      // getEmployeeById should be called with the employee's own ID from the JWT
      expect(profileRepository.getEmployeeById).toHaveBeenCalledWith(
        expect.anything(),
        TEST_EMPLOYEE_ID,
      );
    });

    it("returns 404 when the employee record does not exist", async () => {
      vi.mocked(profileRepository.getEmployeeById).mockResolvedValue(null);

      const res = await app.inject({
        method: "GET",
        url: "/profile/me",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it("fetches stats and expense stats in parallel (both calls happen)", async () => {
      vi.mocked(profileRepository.getEmployeeById).mockResolvedValue(EMPLOYEE_ROW);
      vi.mocked(profileRepository.getEmployeeStats).mockResolvedValue(EMPLOYEE_STATS);
      vi.mocked(profileRepository.getEmployeeExpenseStats).mockResolvedValue(EXPENSE_STATS);

      await app.inject({
        method: "GET",
        url: "/profile/me",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(profileRepository.getEmployeeStats).toHaveBeenCalledOnce();
      expect(profileRepository.getEmployeeExpenseStats).toHaveBeenCalledOnce();
    });

    it("also works with an admin token (admins can have an employee profile)", async () => {
      // Admin token with employee_id embedded
      const adminWithEmployee = app.jwt.sign({
        sub: TEST_ADMIN_ID,
        role: "ADMIN",
        org_id: TEST_ORG_ID,
        employee_id: VALID_ADMIN_UUID, // admin also has an employee record
      });

      vi.mocked(profileRepository.getEmployeeById).mockResolvedValue(ADMIN_ROW);
      vi.mocked(profileRepository.getEmployeeStats).mockResolvedValue({
        totalSessions: 0,
        totalDistanceKm: 0,
        totalDurationSeconds: 0,
      });
      vi.mocked(profileRepository.getEmployeeExpenseStats).mockResolvedValue({
        expensesSubmitted: 0,
        expensesApproved: 0,
      });

      const res = await app.inject({
        method: "GET",
        url: "/profile/me",
        headers: { authorization: `Bearer ${adminWithEmployee}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { data: { id: string } };
      expect(body.data.id).toBe(VALID_ADMIN_UUID);
    });

    it("includes null fields where applicable", async () => {
      const employeeWithNulls = {
        ...EMPLOYEE_ROW,
        employee_code: null,
        phone: null,
        last_activity_at: null,
      };
      vi.mocked(profileRepository.getEmployeeById).mockResolvedValue(employeeWithNulls);
      vi.mocked(profileRepository.getEmployeeStats).mockResolvedValue(EMPLOYEE_STATS);
      vi.mocked(profileRepository.getEmployeeExpenseStats).mockResolvedValue(EXPENSE_STATS);

      const res = await app.inject({
        method: "GET",
        url: "/profile/me",
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        data: { employee_code: null; phone: null; last_activity_at: null };
      };
      expect(body.data.employee_code).toBeNull();
      expect(body.data.phone).toBeNull();
      expect(body.data.last_activity_at).toBeNull();
    });
  });

  // ─── GET /admin/employees/:employeeId/profile ─────────────────────────────

  describe("GET /admin/employees/:employeeId/profile", () => {
    it("returns 401 without a JWT", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/admin/employees/${TEST_EMPLOYEE_ID}/profile`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 for employee tokens (not an admin)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/admin/employees/${TEST_EMPLOYEE_ID}/profile`,
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 400 when employeeId is not a valid UUID", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/employees/not-a-uuid/profile",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 200 with the employee profile for an admin", async () => {
      vi.mocked(profileRepository.getEmployeeById).mockResolvedValue(EMPLOYEE_ROW);
      vi.mocked(profileRepository.getEmployeeStats).mockResolvedValue(EMPLOYEE_STATS);
      vi.mocked(profileRepository.getEmployeeExpenseStats).mockResolvedValue(EXPENSE_STATS);

      const res = await app.inject({
        method: "GET",
        url: `/admin/employees/${VALID_EMPLOYEE_UUID}/profile`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        success: boolean;
        data: {
          id: string;
          name: string;
          stats: {
            totalSessions: number;
            expensesSubmitted: number;
          };
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(VALID_EMPLOYEE_UUID);
      expect(body.data.name).toBe("Alice Smith");
      expect(body.data.stats.totalSessions).toBe(12);
      expect(body.data.stats.expensesSubmitted).toBe(5);
    });

    it("passes the URL param employeeId to getEmployeeById", async () => {
      vi.mocked(profileRepository.getEmployeeById).mockResolvedValue(EMPLOYEE_ROW);
      vi.mocked(profileRepository.getEmployeeStats).mockResolvedValue(EMPLOYEE_STATS);
      vi.mocked(profileRepository.getEmployeeExpenseStats).mockResolvedValue(EXPENSE_STATS);

      await app.inject({
        method: "GET",
        url: `/admin/employees/${VALID_EMPLOYEE_UUID}/profile`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(profileRepository.getEmployeeById).toHaveBeenCalledWith(
        expect.anything(),
        VALID_EMPLOYEE_UUID,
      );
    });

    it("returns 404 when the target employee does not exist in the org", async () => {
      vi.mocked(profileRepository.getEmployeeById).mockResolvedValue(null);

      const res = await app.inject({
        method: "GET",
        url: `/admin/employees/${VALID_EMPLOYEE_UUID}/profile`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for a different org admin requesting a foreign employee", async () => {
      // Org B admin cannot see Org A employee — service enforces tenant via orgTable
      const orgBAdmin = signAdminToken(app, TEST_ADMIN_ID, TEST_ORG_ID_B);
      vi.mocked(profileRepository.getEmployeeById).mockResolvedValue(null); // no match in Org B

      const res = await app.inject({
        method: "GET",
        url: `/admin/employees/${VALID_EMPLOYEE_UUID}/profile`,
        headers: { authorization: `Bearer ${orgBAdmin}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns full profile with zero stats for new employees", async () => {
      const newEmployee = {
        ...EMPLOYEE_ROW,
        id: VALID_ADMIN_UUID,
        name: "New Employee",
        employee_code: null,
      };
      vi.mocked(profileRepository.getEmployeeById).mockResolvedValue(newEmployee);
      vi.mocked(profileRepository.getEmployeeStats).mockResolvedValue({
        totalSessions: 0,
        totalDistanceKm: 0,
        totalDurationSeconds: 0,
      });
      vi.mocked(profileRepository.getEmployeeExpenseStats).mockResolvedValue({
        expensesSubmitted: 0,
        expensesApproved: 0,
      });

      const res = await app.inject({
        method: "GET",
        url: `/admin/employees/${VALID_ADMIN_UUID}/profile`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        data: { stats: { totalSessions: number; totalDistanceKm: number } };
      };
      expect(body.data.stats.totalSessions).toBe(0);
      expect(body.data.stats.totalDistanceKm).toBe(0);
    });
  });
});
