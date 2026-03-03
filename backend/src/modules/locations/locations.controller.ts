import type { FastifyRequest, FastifyReply } from "fastify";
import { locationsService } from "./locations.service.js";
import { createLocationSchema, createLocationBatchSchema, sessionQuerySchema } from "./locations.schema.js";
import { AppError } from "../../utils/errors.js";

/**
 * Location controller — extracts request data, validates, calls service, returns response.
 */
export const locationsController = {
    async recordLocation(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            const parsedBody = createLocationSchema.parse(request.body);
            const record = await locationsService.recordLocation(request, parsedBody);
            reply.status(201).send({ success: true, data: record });
        } catch (error) {
            if (error instanceof AppError) {
                reply.status(error.statusCode).send({ error: error.message });
                return;
            }
            if (error instanceof Error && error.name === "ZodError") {
                reply.status(400).send({ error: JSON.parse(error.message) });
                return;
            }
            request.log.error(error, "Unexpected error ingesting location");
            reply.status(500).send({ error: "Internal server error" });
        }
    },

    async recordLocationBatch(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            const parsedBody = createLocationBatchSchema.parse(request.body);
            const inserted = await locationsService.recordLocationBatch(request, parsedBody);
            reply.status(201).send({ success: true, inserted });
        } catch (error) {
            if (error instanceof AppError) {
                reply.status(error.statusCode).send({ error: error.message });
                return;
            }
            if (error instanceof Error && error.name === "ZodError") {
                reply.status(400).send({ error: JSON.parse(error.message) });
                return;
            }
            request.log.error(error, "Unexpected error ingesting location batch");
            reply.status(500).send({ error: "Internal server error" });
        }
    },

    async getRoute(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            const parsedQuery = sessionQuerySchema.parse(request.query);
            const route = await locationsService.getRoute(request, parsedQuery.sessionId);
            reply.status(200).send({ success: true, data: route });
        } catch (error) {
            if (error instanceof AppError) {
                reply.status(error.statusCode).send({ error: error.message });
                return;
            }
            if (error instanceof Error && error.name === "ZodError") {
                reply.status(400).send({ error: JSON.parse(error.message) });
                return;
            }
            request.log.error(error, "Unexpected error fetching location route");
            reply.status(500).send({ error: "Internal server error" });
        }
    },
};
