import type { FastifyRequest, FastifyReply } from "fastify";
import { locationsService } from "./locations.service.js";
import { createLocationSchema, createLocationBatchSchema, sessionQuerySchema } from "./locations.schema.js";
import { ok, fail, handleError } from "../../utils/response.js";

/**
 * Location controller — extracts request data, validates, calls service, returns response.
 */
export const locationsController = {
    async recordLocation(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            const parsedBody = createLocationSchema.parse(request.body);
            const record = await locationsService.recordLocation(request, parsedBody);
            reply.status(201).send(ok(record));
        } catch (error) {
            handleError(error, request, reply, "Unexpected error ingesting location");
        }
    },

    async recordLocationBatch(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            const parsedBody = createLocationBatchSchema.parse(request.body);
            const inserted = await locationsService.recordLocationBatch(request, parsedBody);
            reply.status(201).send({ success: true, inserted });
        } catch (error) {
            handleError(error, request, reply, "Unexpected error ingesting location batch");
        }
    },

    async getRoute(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            const parsedQuery = sessionQuerySchema.parse(request.query);
            // Accept both camelCase (sessionId) and snake_case (session_id)
            const sessionId = parsedQuery.sessionId ?? parsedQuery.session_id;
            if (!sessionId) {
                reply.status(400).send(fail("sessionId is required", request.id, "VALIDATION_ERROR", { field: "sessionId" }));
                return;
            }
            const route = await locationsService.getRoute(request, sessionId);
            reply.status(200).send(ok(route));
        } catch (error) {
            handleError(error, request, reply, "Unexpected error fetching location route");
        }
    },
};
