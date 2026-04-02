import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { monitoringController } from "./monitoring.controller.js";
import { monitoringPaginationSchema } from "./monitoring.service.js";

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
      schema: { tags: ["admin"] },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    monitoringController.start,
  );

  app.post(
    "/admin/stop-monitoring",
    {
      schema: { tags: ["admin"] },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    monitoringController.stop,
  );

  app.get(
    "/admin/monitoring-history",
    {
      schema: { tags: ["admin"], querystring: monitoringPaginationSchema },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    monitoringController.history,
  );
}
