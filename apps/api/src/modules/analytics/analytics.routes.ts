import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { analyticsController } from "./analytics.controller.js";
import {
  orgSummaryQuerySchema,
  userSummaryQuerySchema,
  topPerformersQuerySchema,
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
  }),
});

const unknownObject = z.object({}).passthrough();

const topPerformersResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(unknownObject),
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
  }),
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
        response: { 200: orgSummaryResponseSchema },
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
        response: { 200: userSummaryResponseSchema },
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
        response: { 200: topPerformersResponseSchema },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    analyticsController.getTopPerformers,
  );
}
