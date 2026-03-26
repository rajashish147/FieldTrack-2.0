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

// locations.service.ts uses both repositories
vi.mock("../../../src/modules/locations/locations.repository.js", () => ({
  locationsRepository: {
    createLocation: vi.fn(),
    createLocationBatch: vi.fn(),
    findLocationsBySession: vi.fn(),
    findPointsForDistancePaginated: vi.fn(),
  },
}));

vi.mock("../../../src/modules/attendance/attendance.repository.js", () => ({
  attendanceRepository: {
    findOpenSession: vi.fn(),
    createSession: vi.fn(),
    closeSession: vi.fn(),
    findSessionsByUser: vi.fn(),
    findSessionsByOrg: vi.fn(),
    validateSessionActive: vi.fn(),
    getSessionCheckinAt: vi.fn(),
  },
}));

// metrics are in-memory counters — mock to avoid prom-client cross-test noise
vi.mock("../../../src/utils/metrics.js", () => ({
  metrics: {
    incrementLocationsInserted: vi.fn(),
    incrementRecalculations: vi.fn(),
    recordRecalculationTime: vi.fn(),
    getSnapshot: vi.fn().mockReturnValue({}),
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
  TEST_SESSION_ID,
} from "../../setup/test-server.js";
import { locationsRepository } from "../../../src/modules/locations/locations.repository.js";
import { attendanceRepository } from "../../../src/modules/attendance/attendance.repository.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

function makePoint(overrides?: Partial<typeof basePoint>) {
  return { ...basePoint, ...overrides };
}

const basePoint = {
  latitude: 51.5074,
  longitude: -0.1278,
  accuracy: 5,
  recorded_at: new Date().toISOString(),
};

const locationRecord = {
  id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
  organization_id: TEST_ORG_ID,
  session_id: TEST_SESSION_ID,
  employee_id: TEST_EMPLOYEE_ID,
  latitude: 51.5074,
  longitude: -0.1278,
  accuracy: 5,
  recorded_at: new Date().toISOString(),
  sequence_number: 1,
  is_duplicate: false,
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Locations Integration Tests", () => {
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

  // ─── POST /locations ─────────────────────────────────────────────────────────

  describe("POST /locations", () => {
    it("returns 401 without a JWT", async () => {
      const res = await app.inject({ method: "POST", url: "/locations" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 when called by an ADMIN", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/locations",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_id: TEST_SESSION_ID,
          ...basePoint,
        }),
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 201 with the saved location record", async () => {
      vi.mocked(attendanceRepository.validateSessionActive).mockResolvedValue(true);
      vi.mocked(locationsRepository.createLocation).mockResolvedValue(
        locationRecord as never,
      );

      const res = await app.inject({
        method: "POST",
        url: "/locations",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ session_id: TEST_SESSION_ID, ...basePoint }),
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { success: boolean; data: typeof locationRecord };
      expect(body.success).toBe(true);
      expect(body.data.session_id).toBe(TEST_SESSION_ID);
    });

    it("returns 400 when session is not active", async () => {
      vi.mocked(attendanceRepository.validateSessionActive).mockResolvedValue(false);

      const res = await app.inject({
        method: "POST",
        url: "/locations",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ session_id: TEST_SESSION_ID, ...basePoint }),
      });

      expect(res.statusCode).toBe(400);
    });

    // ─── Schema validation ────────────────────────────────────────────────────

    it("returns 400 for latitude out of range (> 90)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/locations",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_id: TEST_SESSION_ID,
          ...makePoint({ latitude: 95 }),
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for longitude out of range (< -180)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/locations",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_id: TEST_SESSION_ID,
          ...makePoint({ longitude: -200 }),
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for negative accuracy", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/locations",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_id: TEST_SESSION_ID,
          ...makePoint({ accuracy: -1 }),
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when session_id is not a valid UUID", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/locations",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ session_id: "not-a-uuid", ...basePoint }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when recorded_at is more than 2 minutes in the future", async () => {
      const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const res = await app.inject({
        method: "POST",
        url: "/locations",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_id: TEST_SESSION_ID,
          ...makePoint({ recorded_at: future }),
        }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── POST /locations/batch ────────────────────────────────────────────────────

  describe("POST /locations/batch", () => {
    const validBatch = {
      session_id: TEST_SESSION_ID,
      points: [
        makePoint(),
        makePoint({ latitude: 51.51, longitude: -0.13 }),
      ],
    };

    it("returns 401 without a JWT", async () => {
      const res = await app.inject({ method: "POST", url: "/locations/batch" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 201 with inserted count on success", async () => {
      vi.mocked(attendanceRepository.validateSessionActive).mockResolvedValue(true);
      vi.mocked(locationsRepository.createLocationBatch).mockResolvedValue(2 as never);

      const res = await app.inject({
        method: "POST",
        url: "/locations/batch",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(validBatch),
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { success: boolean; inserted: number };
      expect(body.success).toBe(true);
      expect(body.inserted).toBe(2);
    });

    it("returns 400 when points array is empty", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/locations/batch",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ session_id: TEST_SESSION_ID, points: [] }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when points array exceeds 100 items", async () => {
      const tooMany = Array.from({ length: 101 }, (_, i) =>
        makePoint({ latitude: 51.5 + i * 0.001 }),
      );
      const res = await app.inject({
        method: "POST",
        url: "/locations/batch",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ session_id: TEST_SESSION_ID, points: tooMany }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when the session is not active", async () => {
      vi.mocked(attendanceRepository.validateSessionActive).mockResolvedValue(false);

      const res = await app.inject({
        method: "POST",
        url: "/locations/batch",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(validBatch),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── H3: GPS timestamp / sequence validation ─────────────────────────────────

  describe("H3 — GPS data integrity validation", () => {
    const SESSION_START = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    const BEFORE_SESSION = new Date(Date.now() - 120_000).toISOString(); // 2 min ago (before session)
    const AFTER_SESSION = new Date(Date.now() - 30_000).toISOString(); // 30 s ago (valid)

    it("POST /locations — rejects a point with recorded_at before session start (400)", async () => {
      vi.mocked(attendanceRepository.validateSessionActive).mockResolvedValue(true);
      vi.mocked(attendanceRepository.getSessionCheckinAt).mockResolvedValue(SESSION_START);

      const res = await app.inject({
        method: "POST",
        url: "/locations",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_id: TEST_SESSION_ID,
          ...basePoint,
          recorded_at: BEFORE_SESSION,
        }),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { success: false; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/before the session start/i);
    });

    it("POST /locations — accepts a point with recorded_at after session start (201)", async () => {
      vi.mocked(attendanceRepository.validateSessionActive).mockResolvedValue(true);
      vi.mocked(attendanceRepository.getSessionCheckinAt).mockResolvedValue(SESSION_START);
      vi.mocked(locationsRepository.createLocation).mockResolvedValue(locationRecord as never);

      const res = await app.inject({
        method: "POST",
        url: "/locations",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_id: TEST_SESSION_ID,
          ...basePoint,
          recorded_at: AFTER_SESSION,
        }),
      });

      expect(res.statusCode).toBe(201);
    });

    it("POST /locations/batch — rejects when a point is before session start (400)", async () => {
      vi.mocked(attendanceRepository.validateSessionActive).mockResolvedValue(true);
      vi.mocked(attendanceRepository.getSessionCheckinAt).mockResolvedValue(SESSION_START);

      const res = await app.inject({
        method: "POST",
        url: "/locations/batch",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_id: TEST_SESSION_ID,
          points: [
            { ...basePoint, recorded_at: AFTER_SESSION },
            { ...basePoint, latitude: 51.51, recorded_at: BEFORE_SESSION }, // bad
          ],
        }),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { success: false; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/before the session start/i);
    });

    it("POST /locations/batch — rejects out-of-order sequence_number (400, schema level)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/locations/batch",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_id: TEST_SESSION_ID,
          points: [
            { ...basePoint, sequence_number: 3 },
            { ...basePoint, latitude: 51.51, sequence_number: 1 }, // out of order
          ],
        }),
      });

      expect(res.statusCode).toBe(400);
    });

    it("POST /locations/batch — accepts monotonically increasing sequence_number (201)", async () => {
      vi.mocked(attendanceRepository.validateSessionActive).mockResolvedValue(true);
      vi.mocked(attendanceRepository.getSessionCheckinAt).mockResolvedValue(SESSION_START);
      vi.mocked(locationsRepository.createLocationBatch).mockResolvedValue(2 as never);

      const res = await app.inject({
        method: "POST",
        url: "/locations/batch",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_id: TEST_SESSION_ID,
          points: [
            { ...basePoint, recorded_at: AFTER_SESSION, sequence_number: 1 },
            { ...basePoint, latitude: 51.51, recorded_at: new Date().toISOString(), sequence_number: 2 },
          ],
        }),
      });

      expect(res.statusCode).toBe(201);
    });
  });

  // ─── GET /locations/my-route ──────────────────────────────────────────────────

  describe("GET /locations/my-route", () => {
    it("returns 401 without a JWT", async () => {
      const res = await app.inject({ method: "GET", url: "/locations/my-route" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with an array of location points", async () => {
      vi.mocked(locationsRepository.findLocationsBySession).mockResolvedValue([
        locationRecord,
      ] as never);

      const res = await app.inject({
        method: "GET",
        url: `/locations/my-route?sessionId=${TEST_SESSION_ID}`,
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
    });

    it("passes employeeId to the repository for employee-scoped access", async () => {
      vi.mocked(locationsRepository.findLocationsBySession).mockResolvedValue([] as never);

      await app.inject({
        method: "GET",
        url: `/locations/my-route?sessionId=${TEST_SESSION_ID}`,
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(locationsRepository.findLocationsBySession).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SESSION_ID,
        TEST_EMPLOYEE_ID, // employee-scoped: only their own tracks
      );
    });

    it("returns 400 when sessionId is not a valid UUID", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/locations/my-route?sessionId=not-a-uuid",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when sessionId query param is missing", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/locations/my-route",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Multi-tenant isolation ───────────────────────────────────────────────────

  describe("Multi-tenant isolation", () => {
    it("propagates organizationId from JWT to the repository", async () => {
      vi.mocked(locationsRepository.findLocationsBySession).mockResolvedValue([] as never);

      const tokenOrgB = signEmployeeToken(app, TEST_EMPLOYEE_ID, TEST_ORG_ID_B);
      await app.inject({
        method: "GET",
        url: `/locations/my-route?sessionId=${TEST_SESSION_ID}`,
        headers: { authorization: `Bearer ${tokenOrgB}` },
      });

      expect(locationsRepository.findLocationsBySession).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: TEST_ORG_ID_B }),
        TEST_SESSION_ID,
        TEST_EMPLOYEE_ID,
      );
    });

    it("employee cannot fetch another employee's route (employee_id scoping)", async () => {
      vi.mocked(locationsRepository.findLocationsBySession).mockResolvedValue([] as never);

      const otherEmployee = "ffffffff-ffff-ffff-ffff-ffffffffffff";
      const tokenOtherEmployee = signEmployeeToken(app, otherEmployee, TEST_ORG_ID);

      await app.inject({
        method: "GET",
        url: `/locations/my-route?sessionId=${TEST_SESSION_ID}`,
        headers: { authorization: `Bearer ${tokenOtherEmployee}` },
      });

      // Repository must be called with the token owner's ID, not someone else's
      expect(locationsRepository.findLocationsBySession).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SESSION_ID,
        otherEmployee,
      );
    });
  });
});
