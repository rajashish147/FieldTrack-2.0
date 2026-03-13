import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { monitoringController } from "./monitoring.controller.js";
import { monitoringPaginationSchema } from "./monitoring.service.js";

const adminSessionSchema = z.object({
  id: z.string().uuid(),
  admin_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  created_at: z.string(),
});

const monitoringSessionResponseSchema = z.object({
  success: z.literal(true),
  data: adminSessionSchema,
});

const monitoringHistoryResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(adminSessionSchema),
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
      schema: { tags: ["admin"], response: { 201: monitoringSessionResponseSchema } },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    monitoringController.start,
  );

  app.post(
    "/admin/stop-monitoring",
    {
      schema: { tags: ["admin"], response: { 200: monitoringSessionResponseSchema } },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    monitoringController.stop,
  );

  app.get(
    "/admin/monitoring-history",
    {
      schema: { tags: ["admin"], querystring: monitoringPaginationSchema, response: { 200: monitoringHistoryResponseSchema } },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    monitoringController.history,
  );
}
