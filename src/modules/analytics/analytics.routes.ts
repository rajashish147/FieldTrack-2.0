import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { analyticsController } from "./analytics.controller.js";
import {
  orgSummaryQuerySchema,
  userSummaryQuerySchema,
  topPerformersQuerySchema,
  sessionTrendQuerySchema,
  leaderboardQuerySchema,
  orgSummaryResponseSchema,
  userSummaryResponseSchema,
  topPerformersResponseSchema,
  sessionTrendResponseSchema,
  leaderboardResponseSchema,
} from "./analytics.schema.js";

/**
 * Analytics routes — all endpoints require JWT authentication + ADMIN role.
 *
 * EMPLOYEE tokens receive 403. Missing/invalid tokens receive 401.
 * No analytics data is ever exposed to non-admin identities.
 */
export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/admin/org-summary",
    {
      schema: {
        tags: ["admin"],
        querystring: orgSummaryQuerySchema,
        response: { 200: orgSummaryResponseSchema.describe("Org-level analytics summary") },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    analyticsController.getOrgSummary,
  );

  app.get(
    "/admin/user-summary",
    {
      schema: {
        tags: ["admin"],
        querystring: userSummaryQuerySchema,
        response: { 200: userSummaryResponseSchema.describe("Per-user analytics summary") },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    analyticsController.getUserSummary,
  );

  app.get(
    "/admin/top-performers",
    {
      schema: {
        tags: ["admin"],
        querystring: topPerformersQuerySchema,
        response: { 200: topPerformersResponseSchema.describe("Ranked top performers") },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    analyticsController.getTopPerformers,
  );

  // ─── Phase 20: Session Trend ──────────────────────────────────────────────

  app.get(
    "/admin/session-trend",
    {
      schema: {
        tags: ["admin"],
        querystring: sessionTrendQuerySchema,
        response: { 200: sessionTrendResponseSchema.describe("Daily session trend data") },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    analyticsController.getSessionTrend,
  );

  // ─── Phase 20: Leaderboard ────────────────────────────────────────────────

  app.get(
    "/admin/leaderboard",
    {
      schema: {
        tags: ["admin"],
        querystring: leaderboardQuerySchema,
        response: { 200: leaderboardResponseSchema.describe("Employee leaderboard") },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    analyticsController.getLeaderboard,
  );

  // ─── Phase 20b: Public Leaderboard (all authenticated users) ─────────────
  // Same data as /admin/leaderboard but accessible to EMPLOYEE role too,
  // so employees can see the org-wide ranking on their dashboard / leaderboard page.

  app.get(
    "/leaderboard",
    {
      schema: {
        tags: ["analytics"],
        querystring: leaderboardQuerySchema,
        response: { 200: leaderboardResponseSchema.describe("Employee leaderboard") },
      },
      preValidation: [authenticate],
    },
    analyticsController.getLeaderboard,
  );
}
