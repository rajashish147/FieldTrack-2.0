import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { analyticsController } from "./analytics.controller.js";

/**
 * Analytics routes — all endpoints require JWT authentication + ADMIN role.
 *
 * EMPLOYEE tokens receive 403. Missing/invalid tokens receive 401.
 * No analytics data is ever exposed to non-admin identities.
 */
export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  const adminGuard = { preHandler: [authenticate, requireRole("ADMIN")] };

  /**
   * GET /admin/org-summary
   * Organisation-wide totals: sessions, distance, duration, expenses, active users.
   * Query params: from (ISO-8601, optional), to (ISO-8601, optional)
   */
  app.get("/admin/org-summary", adminGuard, analyticsController.getOrgSummary);

  /**
   * GET /admin/user-summary
   * Per-user totals and averages within an optional date range.
   * Query params: userId (UUID, required), from (optional), to (optional)
   */
  app.get(
    "/admin/user-summary",
    adminGuard,
    analyticsController.getUserSummary,
  );

  /**
   * GET /admin/top-performers
   * Ranked leaderboard by distance, duration, or session count.
   * Query params: metric (required), from (optional), to (optional), limit (1-50, default 10)
   */
  app.get(
    "/admin/top-performers",
    adminGuard,
    analyticsController.getTopPerformers,
  );
}
