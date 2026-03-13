import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { locationsController } from "./locations.controller.js";
import {
    createLocationSchema,
    createLocationBatchSchema,
    sessionQuerySchema,
} from "./locations.schema.js";

const locationItemSchema = z.object({
    id: z.string().uuid(),
    session_id: z.string().uuid(),
    organization_id: z.string().uuid(),
    latitude: z.number(),
    longitude: z.number(),
    accuracy: z.number().nullable(),
    recorded_at: z.string(),
    created_at: z.string(),
    sequence_number: z.number().nullable(),
});

const locationResponseSchema = z.object({
    success: z.literal(true),
    data: locationItemSchema,
});

const locationListResponseSchema = z.object({
    success: z.literal(true),
    data: z.array(locationItemSchema),
});

const batchLocationResponseSchema = z.object({
    success: z.literal(true),
    inserted: z.unknown(),
});

/**
 * Location routes — endpoints for ingesting and retrieving GPS tracks.
 */
export async function locationsRoutes(app: FastifyInstance): Promise<void> {
    // Ingest location — EMPLOYEE only
    app.post(
        "/locations",
        {
            schema: { tags: ["locations"], body: createLocationSchema, response: { 201: locationResponseSchema } },
            config: {
                rateLimit: {
                    max: 10,
                    timeWindow: 10000,
                    keyGenerator: (req: FastifyRequest) => req.user?.sub ?? req.ip,
                },
            },
            // preValidation ensures 401/403 fires before Zod body validation
            preValidation: [authenticate, requireRole("EMPLOYEE")],
        },
        locationsController.recordLocation,
    );

    // Bulk ingest locations — EMPLOYEE only
    app.post(
        "/locations/batch",
        {
            schema: { tags: ["locations"], body: createLocationBatchSchema, response: { 201: batchLocationResponseSchema } },
            config: {
                rateLimit: {
                    max: 10,
                    timeWindow: 10000,
                    keyGenerator: (req: FastifyRequest) => req.user?.sub ?? req.ip,
                },
            },
            // preValidation ensures 401/403 fires before Zod body validation
            preValidation: [authenticate, requireRole("EMPLOYEE")],
        },
        locationsController.recordLocationBatch,
    );

    // Retrieve route — specific session history (EMPLOYEE)
    app.get(
        "/locations/my-route",
        {
            schema: { tags: ["locations"], querystring: sessionQuerySchema, response: { 200: locationListResponseSchema } },
            // preValidation ensures 401/403 fires before querystring validation
            preValidation: [authenticate, requireRole("EMPLOYEE")],
        },
        locationsController.getRoute,
    );
}
