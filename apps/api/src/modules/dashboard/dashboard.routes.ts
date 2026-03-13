import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { dashboardController } from "./dashboard.controller.js";

const dashboardSummaryResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    sessionsThisWeek: z.number(),
    distanceThisWeek: z.number(),
    hoursThisWeek: z.number(),
    expensesSubmitted: z.number(),
    expensesApproved: z.number(),
  }),
});

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
      schema: { tags: ["dashboard"], response: { 200: dashboardSummaryResponseSchema } },
      preValidation: [authenticate],
    },
    dashboardController.getMySummary,
  );
}
