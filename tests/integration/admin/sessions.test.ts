import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

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
  TEST_EMPLOYEE_ID,
  TEST_SESSION_ID,
} from "../../setup/test-server.js";
import { attendanceRepository } from "../../../src/modules/attendance/attendance.repository.js";
import type { EnrichedAttendanceSession } from "../../../src/modules/attendance/attendance.repository.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const NOW = new Date().toISOString();
const YESTERDAY = new Date(Date.now() - 86_400_000 * 1.5).toISOString();

function makeSnapshot(overrides: Partial<EnrichedAttendanceSession> = {}): EnrichedAttendanceSession {
  return {
    id: TEST_SESSION_ID,
    employee_id: TEST_EMPLOYEE_ID,
    organization_id: TEST_ORG_ID,
    checkin_at: NOW,
    checkout_at: null,
    total_distance_km: null,
    total_duration_seconds: null,
    distance_recalculation_status: "pending",
    created_at: NOW,
    updated_at: NOW,
    employee_code: "EMP001",
    employee_name: "Test Employee",
    activityStatus: "ACTIVE",
    ...overrides,
  } as EnrichedAttendanceSession;
}

const activeSnapshot = makeSnapshot({ activityStatus: "ACTIVE" });

const recentSnapshot = makeSnapshot({
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  employee_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  checkin_at: YESTERDAY,
  checkout_at: YESTERDAY,
  activityStatus: "RECENT",
  employee_name: "Recent Employee",
  employee_code: "EMP002",
});

const inactiveSnapshot = makeSnapshot({
  id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  employee_id: "00000000-0000-4000-8000-000000000001",
  checkin_at: YESTERDAY,
  checkout_at: YESTERDAY,
  activityStatus: "INACTIVE",
  employee_name: "Inactive Employee",
  employee_code: "EMP003",
});

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("GET /admin/sessions", () => {
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
    vi.mocked(attendanceRepository.findLatestSessionPerEmployee).mockResolvedValue({
      data: [activeSnapshot],
      total: 1,
    });
  });

  // ─── Auth / RBAC ─────────────────────────────────────────────────────────────

  it("returns 401 when no JWT is provided", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/sessions" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when called by a non-ADMIN employee", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/sessions",
      headers: { authorization: `Bearer ${employeeToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── Happy path ───────────────────────────────────────────────────────────────

  it("returns 200 with snapshot data for ADMIN", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/sessions",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      success: boolean;
      data: typeof activeSnapshot[];
      pagination: { page: number; limit: number; total: number };
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].employee_id).toBe(TEST_EMPLOYEE_ID);
    expect(body.data[0].activityStatus).toBe("ACTIVE");
  });

  it("includes pagination metadata in the response", async () => {
    vi.mocked(attendanceRepository.findLatestSessionPerEmployee).mockResolvedValue({
      data: [activeSnapshot],
      total: 42,
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/sessions?page=2&limit=10",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { pagination: { page: number; limit: number; total: number } };
    expect(body.pagination.page).toBe(2);
    expect(body.pagination.limit).toBe(10);
    expect(body.pagination.total).toBe(42);
  });

  it("uses default limit of 50 when none is supplied", async () => {
    await app.inject({
      method: "GET",
      url: "/admin/sessions",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // Service calls findLatestSessionPerEmployee with page=1, limit=50
    expect(attendanceRepository.findLatestSessionPerEmployee).toHaveBeenCalledWith(
      expect.anything(), // request
      1,
      50,
      "all",
    );
  });

  // ─── Status filter ────────────────────────────────────────────────────────────

  it("accepts a valid ?status filter and forwards it to the repository", async () => {
    vi.mocked(attendanceRepository.findLatestSessionPerEmployee).mockResolvedValue({
      data: [activeSnapshot],
      total: 1,
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/sessions?status=active",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(attendanceRepository.findLatestSessionPerEmployee).toHaveBeenCalledWith(
      expect.anything(),
      1,
      50,
      "active",
    );
  });

  it("returns 400 for an invalid ?status value", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/sessions?status=unknown",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(400);
  });

  // ─── Sorting order ────────────────────────────────────────────────────────────

  it("returns ACTIVE employees before RECENT and INACTIVE", async () => {
    // Repository returns data already ordered by status_priority (snapshot table)
    vi.mocked(attendanceRepository.findLatestSessionPerEmployee).mockResolvedValue({
      data: [activeSnapshot, recentSnapshot, inactiveSnapshot],
      total: 3,
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/sessions",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ activityStatus: string }> };
    expect(body.data[0].activityStatus).toBe("ACTIVE");
    expect(body.data[1].activityStatus).toBe("RECENT");
    expect(body.data[2].activityStatus).toBe("INACTIVE");
  });

  // ─── Snapshot table — single row per employee ─────────────────────────────────

  it("returns exactly one row per employee (enforced by the snapshot table)", async () => {
    const snapshots = [activeSnapshot, recentSnapshot, inactiveSnapshot];
    vi.mocked(attendanceRepository.findLatestSessionPerEmployee).mockResolvedValue({
      data: snapshots,
      total: 3,
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/sessions",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const body = JSON.parse(res.body) as { data: Array<{ employee_id: string }> };
    const employeeIds = body.data.map((d) => d.employee_id);
    const uniqueIds = new Set(employeeIds);
    // No duplicate employee_ids in the response
    expect(uniqueIds.size).toBe(employeeIds.length);
  });

  // ─── Limit guard ─────────────────────────────────────────────────────────────

  it("rejects ?limit above 1000", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/sessions?limit=1500",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(400);
  });

  // ─── Empty result ─────────────────────────────────────────────────────────────

  it("returns an empty array when no sessions exist", async () => {
    vi.mocked(attendanceRepository.findLatestSessionPerEmployee).mockResolvedValue({
      data: [],
      total: 0,
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/sessions",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[]; pagination: { total: number } };
    expect(body.data).toHaveLength(0);
    expect(body.pagination.total).toBe(0);
  });

  // ─── Employee name in response ─────────────────────────────────────────────

  it("includes employee_name and employee_code in each session row", async () => {
    vi.mocked(attendanceRepository.findLatestSessionPerEmployee).mockResolvedValue({
      data: [activeSnapshot, recentSnapshot],
      total: 2,
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/sessions",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      data: Array<{ employee_name: string | null; employee_code: string | null }>;
    };
    // Both rows must carry real names, not generated identifiers.
    expect(body.data[0].employee_name).toBe("Test Employee");
    expect(body.data[0].employee_code).toBe("EMP001");
    expect(body.data[1].employee_name).toBe("Recent Employee");
    expect(body.data[1].employee_code).toBe("EMP002");
  });
});
