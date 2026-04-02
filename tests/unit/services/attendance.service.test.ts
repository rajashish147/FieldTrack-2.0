import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  EmployeeAlreadyCheckedIn,
  ForbiddenError,
  SessionAlreadyClosed,
} from "../../../src/utils/errors.js";

// ─── Module mocks (hoisted before all imports) ────────────────────────────────

vi.mock("../../../src/modules/attendance/attendance.repository.js", () => ({
  attendanceRepository: {
    findOpenSession: vi.fn(),
    createSession: vi.fn(),
    closeSession: vi.fn(),
    findSessionsByUser: vi.fn(),
    findSessionsByOrg: vi.fn(),
    validateSessionActive: vi.fn(),
    getSessionCheckinAt: vi.fn(),
    upsertLatestSession: vi.fn().mockResolvedValue(undefined),
    updateLatestSessionDistance: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../../src/workers/distance.queue.js", () => ({
  enqueueDistanceJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/workers/analytics.queue.js", () => ({
  enqueueAnalyticsJob: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mocks are declared so they receive mock implementations
import { attendanceService } from "../../../src/modules/attendance/attendance.service.js";
import { attendanceRepository } from "../../../src/modules/attendance/attendance.repository.js";
import { enqueueDistanceJob } from "../../../src/workers/distance.queue.js";
import { enqueueAnalyticsJob } from "../../../src/workers/analytics.queue.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const SESSION_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

// In unit tests, employeeId is embedded directly on the request object
// (mirrors what auth middleware does via JWT employee_id claim).
// NOTE: pass `undefined` explicitly to test the "no employee" error path —
// do NOT use a default here, since JS default params treat undefined as "missing"
// and would silently substitute USER_ID.
function makeFakeRequest(employeeId: string | undefined): FastifyRequest {
  return {
    user: { sub: USER_ID, role: "EMPLOYEE", organization_id: ORG_ID },
    organizationId: ORG_ID,
    employeeId,
    id: "test-req-id",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as FastifyRequest;
}

const openSession = {
  id: SESSION_ID,
  employee_id: USER_ID,
  organization_id: ORG_ID,
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

// ─── attendanceService.checkIn ────────────────────────────────────────────────

// Clear all mock state between every test to prevent describe-block bleed.
beforeEach(() => {
  vi.clearAllMocks();
});

describe("attendanceService.checkIn()", () => {
  beforeEach(() => {
    vi.mocked(attendanceRepository.findOpenSession).mockResolvedValue(null);
    vi.mocked(attendanceRepository.createSession).mockResolvedValue(openSession as never);
  });

  it("returns a new session on successful check-in", async () => {
    const result = await attendanceService.checkIn(makeFakeRequest(USER_ID));
    expect(result).toEqual(openSession);
  });

  it("calls createSession with the resolved employeeId from the request", async () => {
    await attendanceService.checkIn(makeFakeRequest(USER_ID));
    expect(attendanceRepository.createSession).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
    );
  });

  it("throws ForbiddenError when request.employeeId is undefined", async () => {
    await expect(attendanceService.checkIn(makeFakeRequest(undefined))).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("throws EmployeeAlreadyCheckedIn when an open session exists", async () => {
    vi.mocked(attendanceRepository.findOpenSession).mockResolvedValue(
      openSession as never,
    );
    await expect(attendanceService.checkIn(makeFakeRequest(USER_ID))).rejects.toThrow(
      EmployeeAlreadyCheckedIn,
    );
  });

  it("does NOT call createSession if employeeId is missing", async () => {
    await expect(attendanceService.checkIn(makeFakeRequest(undefined))).rejects.toThrow();
    expect(attendanceRepository.createSession).not.toHaveBeenCalled();
  });
});

// ─── attendanceService.checkOut ───────────────────────────────────────────────

describe("attendanceService.checkOut()", () => {
  beforeEach(() => {
    vi.mocked(attendanceRepository.findOpenSession).mockResolvedValue(
      openSession as never,
    );
    vi.mocked(attendanceRepository.closeSession).mockResolvedValue(
      closedSession as never,
    );
  });

  it("returns the closed session on successful check-out", async () => {
    const result = await attendanceService.checkOut(makeFakeRequest(USER_ID));
    expect(result).toEqual(closedSession);
  });

  it("calls closeSession with the open session id", async () => {
    await attendanceService.checkOut(makeFakeRequest(USER_ID));
    expect(attendanceRepository.closeSession).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
    );
  });

  it("enqueues a distance job after closing the session", async () => {
    await attendanceService.checkOut(makeFakeRequest(USER_ID));
    expect(enqueueDistanceJob).toHaveBeenCalledWith(SESSION_ID);
  });

  it("enqueues an analytics job after closing the session", async () => {
    await attendanceService.checkOut(makeFakeRequest(USER_ID));
    expect(enqueueAnalyticsJob).toHaveBeenCalledWith(
      SESSION_ID,
      ORG_ID,
      USER_ID,
    );
  });

  it("throws ForbiddenError when request.employeeId is undefined", async () => {
    await expect(
      attendanceService.checkOut(makeFakeRequest(undefined)),
    ).rejects.toThrow(ForbiddenError);
  });

  it("throws SessionAlreadyClosed when no open session exists", async () => {
    vi.mocked(attendanceRepository.findOpenSession).mockResolvedValue(null);
    await expect(
      attendanceService.checkOut(makeFakeRequest(USER_ID)),
    ).rejects.toThrow(SessionAlreadyClosed);
  });

  it("does NOT call closeSession if there is no open session", async () => {
    vi.mocked(attendanceRepository.findOpenSession).mockResolvedValue(null);
    await expect(
      attendanceService.checkOut(makeFakeRequest(USER_ID)),
    ).rejects.toThrow();
    expect(attendanceRepository.closeSession).not.toHaveBeenCalled();
  });
});
