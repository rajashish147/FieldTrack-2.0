import type { FastifyRequest } from "fastify";
import { attendanceRepository } from "./attendance.repository.js";
import { enqueueDistanceJob } from "../../workers/distance.queue.js";
import {
  EmployeeAlreadyCheckedIn,
  SessionAlreadyClosed,
  requireEmployeeContext,
} from "../../utils/errors.js";
import type { AttendanceSession } from "./attendance.schema.js";
import type { EnrichedAttendanceSession } from "./attendance.repository.js";

/**
 * Attendance service — business logic for check-in/check-out.
 * Enforces rules: no duplicate check-ins, no check-out without open session.
 *
 * Phase: employeeId resolved once in auth middleware (request.employeeId).
 * requireEmployeeContext() asserts presence and narrows the type.
 */
export const attendanceService = {
  async checkIn(request: FastifyRequest): Promise<AttendanceSession> {
    requireEmployeeContext(request);
    const { employeeId } = request;

    const openSession = await attendanceRepository.findOpenSession(request, employeeId);
    if (openSession) throw new EmployeeAlreadyCheckedIn();

    request.log.info(
      { userId: request.user.sub, employeeId, organizationId: request.organizationId },
      "Employee checked in",
    );
    return attendanceRepository.createSession(request, employeeId);
  },

  async checkOut(request: FastifyRequest): Promise<AttendanceSession> {
    requireEmployeeContext(request);
    const { employeeId } = request;

    const openSession = await attendanceRepository.findOpenSession(request, employeeId);
    if (!openSession) throw new SessionAlreadyClosed();

    request.log.info(
      { userId: request.user.sub, employeeId, organizationId: request.organizationId },
      "Employee checked out",
    );
    const closedSession = await attendanceRepository.closeSession(request, openSession.id);

    enqueueDistanceJob(closedSession.id).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      request.log.warn(
        { sessionId: closedSession.id, error: message },
        "Failed to enqueue distance job — session summary may be delayed",
      );
    });

    return closedSession;
  },

  async getMySessions(
    request: FastifyRequest,
    page: number,
    limit: number,
  ): Promise<{ data: EnrichedAttendanceSession[]; total: number }> {
    const employeeId = request.employeeId;
    if (!employeeId) return { data: [], total: 0 };
    return attendanceRepository.findSessionsByUser(request, employeeId, page, limit);
  },

  async getOrgSessions(
    request: FastifyRequest,
    page: number,
    limit: number,
  ): Promise<{ data: EnrichedAttendanceSession[]; total: number }> {
    return attendanceRepository.findSessionsByOrg(request, page, limit);
  },
};
