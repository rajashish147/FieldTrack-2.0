import type { FastifyRequest, FastifyReply } from "fastify";
import { attendanceService } from "./attendance.service.js";
import { paginationSchema } from "./attendance.schema.js";
import { paginated, ok, handleError } from "../../utils/response.js";

/**
 * Attendance controller — extracts request data, calls service, returns response.
 */
export const attendanceController = {
    async checkIn(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            const session = await attendanceService.checkIn(request);
            reply.status(201).send(ok(session));
        } catch (error) {
            handleError(error, request, reply, "Unexpected error during check-in");
        }
    },

    async checkOut(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            const session = await attendanceService.checkOut(request);
            reply.status(200).send(ok(session));
        } catch (error) {
            handleError(error, request, reply, "Unexpected error during check-out");
        }
    },

    async getMySessions(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            const parsed = paginationSchema.parse(request.query);
            const result = await attendanceService.getMySessions(request, parsed.page, parsed.limit);
            reply.status(200).send(paginated(result.data, parsed.page, parsed.limit, result.total));
        } catch (error) {
            handleError(error, request, reply, "Unexpected error fetching user sessions");
        }
    },

    async getOrgSessions(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            const parsed = paginationSchema.parse(request.query);
            const result = await attendanceService.getOrgSessions(request, parsed.page, parsed.limit);
            reply.status(200).send(paginated(result.data, parsed.page, parsed.limit, result.total));
        } catch (error) {
            handleError(error, request, reply, "Unexpected error fetching org sessions");
        }
    },
};
