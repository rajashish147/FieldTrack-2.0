import type { FastifyRequest, FastifyReply } from "fastify";
import { sessionSummaryService } from "./session_summary.service.js";
import { ok, handleError } from "../../utils/response.js";

/**
 * Session Summary controller — endpoint to manually trigger distance regeneration.
 */
export const sessionSummaryController = {
    async recalculate(
        request: FastifyRequest<{ Params: { sessionId: string } }>,
        reply: FastifyReply,
    ): Promise<void> {
        try {
            const { sessionId } = request.params;
            const summary = await sessionSummaryService.calculateAndSave(request, sessionId);
            reply.status(200).send(ok(summary));
        } catch (error) {
            handleError(error, request, reply, "Unexpected error recalculating session summary");
        }
    },
};
