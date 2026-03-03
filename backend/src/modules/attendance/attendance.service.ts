import type { FastifyRequest } from "fastify";
import { attendanceRepository } from "./attendance.repository.js";
import { enqueueDistanceRecalculation } from "../../workers/queue.js";
import { BadRequestError } from "../../utils/errors.js";
import type { AttendanceSession } from "./attendance.schema.js";

/**
 * Attendance service — business logic for check-in/check-out.
 * Enforces rules: no duplicate check-ins, no check-out without open session.
 */
export const attendanceService = {
    /**
     * Check in — creates a new session if no open session exists.
     */
    async checkIn(request: FastifyRequest): Promise<AttendanceSession> {
        const userId = request.user.sub;

        const openSession = await attendanceRepository.findOpenSession(request, userId);
        if (openSession) {
            throw new BadRequestError(
                "Cannot check in: you already have an active session. Check out first.",
            );
        }

        request.log.info({ userId, organizationId: request.organizationId }, "Employee checked in");
        return attendanceRepository.createSession(request, userId);
    },

    /**
     * Check out — closes the open session if one exists.
     * Enqueues the closed session into a background worker for distance calculation.
     */
    async checkOut(request: FastifyRequest): Promise<AttendanceSession> {
        const userId = request.user.sub;

        const openSession = await attendanceRepository.findOpenSession(request, userId);
        if (!openSession) {
            throw new BadRequestError(
                "Cannot check out: no active session found. Check in first.",
            );
        }

        request.log.info({ userId, organizationId: request.organizationId }, "Employee checked out");
        const closedSession = await attendanceRepository.closeSession(request, openSession.id);

        // Phase 7: Enqueue distance computation asynchronously so check-out is instantaneous
        enqueueDistanceRecalculation(closedSession.id);

        return closedSession;
    },


    /**
     * Get the current user's own sessions.
     */
    async getMySessions(
        request: FastifyRequest,
        page: number,
        limit: number,
    ): Promise<AttendanceSession[]> {
        const userId = request.user.sub;
        return attendanceRepository.findSessionsByUser(request, userId, page, limit);
    },

    /**
     * Get all sessions in the organization (ADMIN only).
     * Role enforcement happens at the route level via requireRole middleware.
     */
    async getOrgSessions(
        request: FastifyRequest,
        page: number,
        limit: number,
    ): Promise<AttendanceSession[]> {
        return attendanceRepository.findSessionsByOrg(request, page, limit);
    },
};
