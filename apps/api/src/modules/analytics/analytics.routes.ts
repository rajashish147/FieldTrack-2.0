import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OrgSummaryData, TopPerformerEntry, UserSummaryData, SessionTrendEntry, LeaderboardEntry } from "@fieldtrack/types";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { analyticsController } from "./analytics.controller.js";
import {
  orgSummaryQuerySchema,
  userSummaryQuerySchema,
  topPerformersQuerySchema,
  sessionTrendQuerySchema,
  leaderboardQuerySchema,
} from "./analytics.schema.js";

const orgSummaryResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    totalSessions: z.number(),
    totalDistanceKm: z.number(),
    totalDurationSeconds: z.number(),
    totalExpenses: z.number(),
    approvedExpenseAmount: z.number(),
    rejectedExpenseAmount: z.number(),
    activeEmployeesCount: z.number(),
  }) satisfies z.ZodType<OrgSummaryData>,
});

const topPerformerItemSchema: z.ZodType<TopPerformerEntry> = z.object({
  employeeId: z.string(),
  employeeName: z.string(),
  totalDistanceKm: z.number().optional(),
  totalDurationSeconds: z.number().optional(),
  sessionsCount: z.number().optional(),
});

const topPerformersResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(topPerformerItemSchema),
});

const userSummaryResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    sessionsCount: z.number(),
    totalDistanceKm: z.number(),
    totalDurationSeconds: z.number(),
    totalExpenses: z.number(),
    approvedExpenseAmount: z.number(),
    averageDistancePerSession: z.number(),
    averageSessionDurationSeconds: z.number(),
  }) satisfies z.ZodType<UserSummaryData>,
});

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
        response: { 200: orgSummaryResponseSchema.describe("Organization analytics summary") },
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
        response: { 200: userSummaryResponseSchema.describe("User analytics summary") },
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
        response: { 200: topPerformersResponseSchema.describe("Top performing employees list") },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    analyticsController.getTopPerformers,
  );

  // ─── Phase 20: Session Trend ──────────────────────────────────────────────

  const sessionTrendResponseSchema = z.object({
    success: z.literal(true),
    data: z.array(
      z.object({
        date: z.string(),
        sessions: z.number(),
        distance: z.number(),
        duration: z.number(),
      }) satisfies z.ZodType<SessionTrendEntry>,
    ),
  });

  app.get(
    "/admin/session-trend",
    {
      schema: {
        tags: ["admin"],
        querystring: sessionTrendQuerySchema,
        response: { 200: sessionTrendResponseSchema.describe("Session trend time-series") },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    analyticsController.getSessionTrend,
  );

  // ─── Phase 20: Leaderboard ────────────────────────────────────────────────

  const leaderboardEntrySchema: z.ZodType<LeaderboardEntry> = z.object({
    rank: z.number(),
    employeeId: z.string(),
    employeeCode: z.string().nullable(),
    employeeName: z.string(),
    distance: z.number(),
    sessions: z.number(),
    duration: z.number(),
    expenses: z.number().optional(),
  });

  const leaderboardResponseSchema = z.object({
    success: z.literal(true),
    data: z.array(leaderboardEntrySchema),
  });

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
        response: { 200: leaderboardResponseSchema.describe("Employee leaderboard (tenant-scoped)") },
      },
      preValidation: [authenticate],
    },
    analyticsController.getLeaderboard,
  );
}
