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

vi.mock("../../../src/modules/employees/employees.repository.js", () => ({
  employeesRepository: {
    createEmployee: vi.fn(),
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
} from "../../setup/test-server.js";
import { employeesRepository } from "../../../src/modules/employees/employees.repository.js";
import { BadRequestError } from "../../../src/utils/errors.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const EMPLOYEE_ROW_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const newEmployee = {
  id: EMPLOYEE_ROW_ID,
  organization_id: TEST_ORG_ID,
  user_id: null,
  name: "Alice Smith",
  employee_code: "EMP002",
  phone: null,
  is_active: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Employees Integration Tests", () => {
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

  // ─── POST /admin/employees ────────────────────────────────────────────────────

  describe("POST /admin/employees", () => {
    it("returns 401 when no JWT is provided", async () => {
      const res = await app.inject({ method: "POST", url: "/admin/employees" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 when called by an EMPLOYEE", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/admin/employees",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Bob", employee_code: "EMP003" }),
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 201 with the new employee on valid creation", async () => {
      vi.mocked(employeesRepository.createEmployee).mockResolvedValue(
        newEmployee as never,
      );

      const res = await app.inject({
        method: "POST",
        url: "/admin/employees",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Alice Smith",
          employee_code: "EMP002",
        }),
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { success: boolean; data: typeof newEmployee };
      expect(body.success).toBe(true);
      expect(body.data.employee_code).toBe("EMP002");
      expect(body.data.name).toBe("Alice Smith");
    });

    it("returns 400 when name is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/admin/employees",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ employee_code: "EMP003" }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 201 when employee_code is omitted (auto-generated)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/admin/employees",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Bob" }),
      });
      expect(res.statusCode).toBe(201);
    });

    it("returns 400 when user_id is not a valid UUID", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/admin/employees",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Bob", employee_code: "EMP003", user_id: "not-a-uuid" }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("calls repository with the correct body", async () => {
      vi.mocked(employeesRepository.createEmployee).mockResolvedValue(
        newEmployee as never,
      );

      await app.inject({
        method: "POST",
        url: "/admin/employees",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Alice Smith", employee_code: "EMP002" }),
      });

      expect(employeesRepository.createEmployee).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: "Alice Smith", employee_code: "EMP002" }),
      );
    });

    it("returns 400 when user_id does not match any registered user (FK violation)", async () => {
      vi.mocked(employeesRepository.createEmployee).mockRejectedValue(
        new BadRequestError("user_id '3fa85f64-5717-4562-b3fc-2c963f66afa6' does not correspond to any registered user"),
      );

      const res = await app.inject({
        method: "POST",
        url: "/admin/employees",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Bob",
          employee_code: "EMP003",
          user_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        }),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain("does not correspond to any registered user");
    });

    it("returns 400 when employee_code is already in use (duplicate key)", async () => {
      vi.mocked(employeesRepository.createEmployee).mockRejectedValue(
        new BadRequestError("employee_code 'EMP002' is already in use within this organization"),
      );

      const res = await app.inject({
        method: "POST",
        url: "/admin/employees",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Alice Duplicate", employee_code: "EMP002" }),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain("already in use");
    });
  });
});
