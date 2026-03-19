import type { FastifyRequest } from "fastify";
import { attendanceRepository } from "./attendance.repository.js";
import { enqueueDistanceJob } from "../../workers/distance.queue.js";
import { enqueueAnalyticsJob } from "../../workers/analytics.queue.js";
import { getCached } from "../../utils/cache.js";
import {
  EmployeeAlreadyCheckedIn,
  SessionAlreadyClosed,
  requireEmployeeContext,
} from "../../utils/errors.js";
import type { AttendanceSession } from "./attendance.schema.js";
import type { EnrichedAttendanceSession } from "./attendance.repository.js";
import { profileRepository } from "../profile/profile.repository.js";
import { sseEventBus } from "../../utils/sse-emitter.js";
import { emitEvent } from "../../utils/event-bus.js";

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

    // Update last_activity_at (fire-and-forget)
    profileRepository.updateLastActivity(request, employeeId).catch(() => {});

    const session = await attendanceRepository.createSession(request, employeeId);

    // Keep snapshot table in sync — fire-and-forget so check-in latency is unaffected
    attendanceRepository
      .upsertLatestSession(request.organizationId, employeeId, session)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.warn({ sessionId: session.id, error: msg }, "Failed to upsert latest session snapshot after check-in");
      });

    sseEventBus.emitOrgEvent(request.organizationId, "session.checkin", {
      sessionId: session.id,
      employeeId,
    });

    emitEvent("employee.checked_in", {
      organization_id: request.organizationId,
      data: {
        employee_id: employeeId,
        session_id: session.id,
        checkin_at: session.checkin_at,
      },
    });

    return session;
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

    // Keep snapshot table in sync — fire-and-forget so check-out latency is unaffected
    attendanceRepository
      .upsertLatestSession(request.organizationId, employeeId, closedSession)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.warn({ sessionId: closedSession.id, error: msg }, "Failed to upsert latest session snapshot after check-out");
      });

    sseEventBus.emitOrgEvent(request.organizationId, "session.checkout", {
      sessionId: closedSession.id,
      employeeId,
    });

    emitEvent("employee.checked_out", {
      organization_id: request.organizationId,
      data: {
        employee_id: employeeId,
        session_id: closedSession.id,
        checkin_at: closedSession.checkin_at,
        checkout_at: closedSession.checkout_at ?? new Date().toISOString(),
      },
    });

    enqueueDistanceJob(closedSession.id).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      request.log.warn(
        { sessionId: closedSession.id, error: message },
        "Failed to enqueue distance job — session summary may be delayed",
      );
    });

    // Phase 21: Enqueue analytics aggregation job for this session.
    // The job runs after checkout and recomputes daily metrics once the
    // distance worker has written total_distance_km (exponential backoff
    // of 5 s gives the distance worker plenty of time to finish first).
    enqueueAnalyticsJob(
      closedSession.id,
      request.organizationId,
      employeeId,
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      request.log.warn(
        { sessionId: closedSession.id, error: message },
        "Failed to enqueue analytics job — daily metrics may be delayed",
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
    status: string = "all",
    employeeId?: string,
  ): Promise<{ data: EnrichedAttendanceSession[]; total: number }> {
    // 30-second cache absorbs high-frequency admin polling without stale data
    // risk (session status changes happen at most every few minutes in practice).
    // The cache is cleared by invalidateOrgAnalytics() on every checkout.
    const cacheKey = `org:${request.organizationId}:sessions:${page}:${limit}:${status}:${employeeId ?? "all"}`;
    if (employeeId) {
      return getCached(cacheKey, 30, () =>
        attendanceRepository.findSessionsByUser(request, employeeId, page, limit));
    }
    return getCached(cacheKey, 30, () =>
      attendanceRepository.findLatestSessionPerEmployee(request, page, limit, status));
  },
};
