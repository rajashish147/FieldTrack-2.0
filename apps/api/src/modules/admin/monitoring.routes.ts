import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { monitoringController } from "./monitoring.controller.js";
import { monitoringPaginationSchema } from "./monitoring.service.js";

const adminSessionSchema = z.object({
  id: z.string(),
  admin_id: z.string(),
  organization_id: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  created_at: z.string(),
});

const monitoringSessionResponseSchema = z.object({
  success: z.literal(true),
  data: adminSessionSchema,
});

const paginationMetaSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
});

const monitoringHistoryResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(adminSessionSchema),
  pagination: paginationMetaSchema,
});

/**
 * Admin monitoring routes — all require ADMIN role.
 *
 * POST /admin/start-monitoring  — begin a new admin monitoring session
 * POST /admin/stop-monitoring   — close the current open session
 * GET  /admin/monitoring-history — paginated history of past sessions
 */
export async function monitoringRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/admin/start-monitoring",
    {
      schema: { tags: ["admin"], response: { 201: monitoringSessionResponseSchema.describe("Started monitoring session") } },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    monitoringController.start,
  );

  app.post(
    "/admin/stop-monitoring",
    {
      schema: { tags: ["admin"], response: { 200: monitoringSessionResponseSchema.describe("Stopped monitoring session") } },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    monitoringController.stop,
  );

  app.get(
    "/admin/monitoring-history",
    {
      schema: { tags: ["admin"], querystring: monitoringPaginationSchema, response: { 200: monitoringHistoryResponseSchema.describe("Monitoring session history") } },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    monitoringController.history,
  );
}
