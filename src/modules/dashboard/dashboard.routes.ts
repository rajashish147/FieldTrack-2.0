import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/auth.js";
import { dashboardController } from "./dashboard.controller.js";

/**
 * Dashboard routes — available to any authenticated user.
 * The service returns zeros for users without an employee record (e.g., ADMIN-only).
 *
 * GET /dashboard/my-summary — personal stats for the current ISO week
 */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/dashboard/my-summary",
    {
      schema: { tags: ["dashboard"] },
      preValidation: [authenticate],
    },
    dashboardController.getMySummary,
  );
}
