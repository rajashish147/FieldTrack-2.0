import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  ForbiddenError,
  BadRequestError,
} from "../../../src/utils/errors.js";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../../../src/modules/locations/locations.repository.js", () => ({
  locationsRepository: {
    createLocation: vi.fn(),
    createLocationBatch: vi.fn(),
    findLocationsBySession: vi.fn(),
  },
}));

vi.mock("../../../src/modules/attendance/attendance.repository.js", () => ({
  attendanceRepository: {
    validateSessionActive: vi.fn(),
    getSessionCheckinAt: vi.fn(),
    findOpenSession: vi.fn(),
    createSession: vi.fn(),
    closeSession: vi.fn(),
    findSessionsByUser: vi.fn(),
    findSessionsByOrg: vi.fn(),
  },
}));

vi.mock("../../../src/utils/metrics.js", () => ({
  metrics: {
    incrementLocationsInserted: vi.fn(),
  },
}));

import { locationsService } from "../../../src/modules/locations/locations.service.js";
import { locationsRepository } from "../../../src/modules/locations/locations.repository.js";
import { attendanceRepository } from "../../../src/modules/attendance/attendance.repository.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const EMPLOYEE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ORG_ID     = "11111111-1111-1111-1111-111111111111";
const USER_ID    = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SESSION_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const LOCATION_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function makeFakeRequest(employeeId: string | undefined): FastifyRequest {
  return {
    user: { sub: USER_ID, role: "EMPLOYEE", organization_id: ORG_ID },
    organizationId: ORG_ID,
    employeeId,
    id: "test-req-id",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as FastifyRequest;
}

const locationBody = {
  session_id: SESSION_ID,
  latitude: 28.6139,
  longitude: 77.209,
  recorded_at: new Date().toISOString(),
};

const batchBody = {
  session_id: SESSION_ID,
  points: [
    { latitude: 28.6139, longitude: 77.209, recorded_at: new Date().toISOString() },
    { latitude: 28.614,  longitude: 77.21,  recorded_at: new Date().toISOString() },
  ],
};

const locationRecord = {
  id: LOCATION_ID,
  employee_id: EMPLOYEE_ID,
  session_id: SESSION_ID,
  latitude: 28.6139,
  longitude: 77.209,
  recorded_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
};

// ─── locationsService.recordLocation ─────────────────────────────────────────

describe("locationsService.recordLocation()", () => {
  beforeEach(() => {
    vi.mocked(attendanceRepository.validateSessionActive).mockResolvedValue(true);
    vi.mocked(locationsRepository.createLocation).mockResolvedValue(
      locationRecord as never,
    );
  });

  it("returns the created location record on success", async () => {
    const result = await locationsService.recordLocation(
      makeFakeRequest(EMPLOYEE_ID),
      locationBody,
    );
    expect(result).toEqual(locationRecord);
  });

  it("calls createLocation with employeeId and sessionId", async () => {
    await locationsService.recordLocation(makeFakeRequest(EMPLOYEE_ID), locationBody);
    expect(locationsRepository.createLocation).toHaveBeenCalledWith(
      expect.anything(),
      EMPLOYEE_ID,
      SESSION_ID,
      locationBody,
    );
  });

  it("throws ForbiddenError when employeeId is undefined", async () => {
    await expect(
      locationsService.recordLocation(makeFakeRequest(undefined), locationBody),
    ).rejects.toThrow(ForbiddenError);
  });

  it("throws BadRequestError when session is invalid/closed", async () => {
    vi.mocked(attendanceRepository.validateSessionActive).mockResolvedValue(false);
    await expect(
      locationsService.recordLocation(makeFakeRequest(EMPLOYEE_ID), locationBody),
    ).rejects.toThrow(BadRequestError);
  });

  it("does NOT call createLocation if session validation fails", async () => {
    vi.mocked(attendanceRepository.validateSessionActive).mockResolvedValue(false);
    await expect(
      locationsService.recordLocation(makeFakeRequest(EMPLOYEE_ID), locationBody),
    ).rejects.toThrow();
    expect(locationsRepository.createLocation).not.toHaveBeenCalled();
  });

  it("error message mentions 'closed attendance session' when session is invalid", async () => {
    vi.mocked(attendanceRepository.validateSessionActive).mockResolvedValue(false);
    try {
      await locationsService.recordLocation(makeFakeRequest(EMPLOYEE_ID), locationBody);
    } catch (e) {
      expect((e as Error).message.toLowerCase()).toContain("session");
    }
  });
});

// ─── locationsService.recordLocationBatch ─────────────────────────────────────

describe("locationsService.recordLocationBatch()", () => {
  beforeEach(() => {
    vi.mocked(attendanceRepository.validateSessionActive).mockResolvedValue(true);
    vi.mocked(locationsRepository.createLocationBatch).mockResolvedValue(2);
  });

  it("returns the count of inserted records", async () => {
    const result = await locationsService.recordLocationBatch(
      makeFakeRequest(EMPLOYEE_ID),
      batchBody,
    );
    expect(result).toBe(2);
  });

  it("calls createLocationBatch with employeeId, sessionId, and points array", async () => {
    await locationsService.recordLocationBatch(makeFakeRequest(EMPLOYEE_ID), batchBody);
    expect(locationsRepository.createLocationBatch).toHaveBeenCalledWith(
      expect.anything(),
      EMPLOYEE_ID,
      SESSION_ID,
      batchBody.points,
    );
  });

  it("throws ForbiddenError when employeeId is undefined", async () => {
    await expect(
      locationsService.recordLocationBatch(makeFakeRequest(undefined), batchBody),
    ).rejects.toThrow(ForbiddenError);
  });

  it("throws BadRequestError when session is invalid/closed", async () => {
    vi.mocked(attendanceRepository.validateSessionActive).mockResolvedValue(false);
    await expect(
      locationsService.recordLocationBatch(makeFakeRequest(EMPLOYEE_ID), batchBody),
    ).rejects.toThrow(BadRequestError);
  });

  it("does NOT call createLocationBatch if session validation fails", async () => {
    vi.mocked(attendanceRepository.validateSessionActive).mockResolvedValue(false);
    await expect(
      locationsService.recordLocationBatch(makeFakeRequest(EMPLOYEE_ID), batchBody),
    ).rejects.toThrow();
    expect(locationsRepository.createLocationBatch).not.toHaveBeenCalled();
  });

  it("returns 0 when repo reports 0 inserts (all duplicates suppressed)", async () => {
    vi.mocked(locationsRepository.createLocationBatch).mockResolvedValue(0);
    const result = await locationsService.recordLocationBatch(
      makeFakeRequest(EMPLOYEE_ID),
      batchBody,
    );
    expect(result).toBe(0);
  });
});

// ─── locationsService.getRoute ────────────────────────────────────────────────

describe("locationsService.getRoute()", () => {
  it("returns an array of location records", async () => {
    vi.mocked(locationsRepository.findLocationsBySession).mockResolvedValue(
      [locationRecord] as never,
    );
    const result = await locationsService.getRoute(
      makeFakeRequest(EMPLOYEE_ID),
      SESSION_ID,
    );
    expect(result).toEqual([locationRecord]);
  });

  it("calls findLocationsBySession with sessionId and employeeId", async () => {
    vi.mocked(locationsRepository.findLocationsBySession).mockResolvedValue([]);
    await locationsService.getRoute(makeFakeRequest(EMPLOYEE_ID), SESSION_ID);
    expect(locationsRepository.findLocationsBySession).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      EMPLOYEE_ID,
    );
  });

  it("returns an empty array when no records exist", async () => {
    vi.mocked(locationsRepository.findLocationsBySession).mockResolvedValue([]);
    const result = await locationsService.getRoute(
      makeFakeRequest(EMPLOYEE_ID),
      SESSION_ID,
    );
    expect(result).toEqual([]);
  });
});
