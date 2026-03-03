import type { FastifyRequest, FastifyReply } from "fastify";
import { sessionSummaryService } from "./session_summary.service.js";
import { processingTracker } from "../../workers/queue.js";
import { AppError } from "../../utils/errors.js";

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

            // Phase 7: Guard against triggering recalculation if the background worker is 
            // already proactively crunching this exact session in the background
            if (processingTracker.has(sessionId)) {
                reply.status(409).send({
                    error: "Session is currently being recalculated in the background. Check back in a few seconds."
                });
                return;
            }

            const summary = await sessionSummaryService.calculateAndSave(request, sessionId);
            reply.status(200).send({ success: true, data: summary });
        } catch (error) {
            if (error instanceof AppError) {
                reply.status(error.statusCode).send({ error: error.message });
                return;
            }
            request.log.error(error, "Unexpected error recalculating session summary");
            reply.status(500).send({ error: "Internal server error" });
        }
    },
};
