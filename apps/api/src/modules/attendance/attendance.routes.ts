import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { attendanceController } from "./attendance.controller.js";
import { sessionSummaryController } from "../session_summary/session_summary.controller.js";
import { paginationSchema } from "./attendance.schema.js";

const unknownObject = z.object({}).passthrough();

const singleObjectResponseSchema = z.object({
  success: z.literal(true),
  data: unknownObject,
});

const sessionListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(unknownObject),
});

/**
 * Attendance routes — all endpoints require authentication.
 * ADMIN-only routes use the requireRole middleware.
 */
export async function attendanceRoutes(app: FastifyInstance): Promise<void> {
  // Check in — any authenticated user
  app.post(
    "/attendance/check-in",
    {
      schema: { tags: ["attendance"], response: { 201: singleObjectResponseSchema } },
      preValidation: [authenticate],
    },
    attendanceController.checkIn,
  );

  // Check out — any authenticated user
  app.post(
    "/attendance/check-out",
    {
      schema: { tags: ["attendance"], response: { 200: singleObjectResponseSchema } },
      preValidation: [authenticate],
    },
    attendanceController.checkOut,
  );

  // Recalculate distance and duration explicitly.
  // Rate-limited per IP to prevent recalculation flooding.
  app.post<{ Params: { sessionId: string } }>(
    "/attendance/:sessionId/recalculate",
    {
      schema: { tags: ["attendance"], response: { 200: singleObjectResponseSchema } },
      config: {
        rateLimit: {
          max: 5,
          timeWindow: 60_000,
          keyGenerator: (req: FastifyRequest): string => req.user?.sub ?? req.ip,
        },
      },
      preValidation: [authenticate],
    },
    sessionSummaryController.recalculate,
  );

  // My sessions — employee's own sessions
  app.get(
    "/attendance/my-sessions",
    {
      schema: {
        tags: ["attendance"],
        querystring: paginationSchema,
        response: { 200: sessionListResponseSchema },
      },
      // preValidation ensures 401 fires before querystring validation
      preValidation: [authenticate],
    },
    attendanceController.getMySessions,
  );

  // Org sessions — ADMIN only
  app.get(
    "/attendance/org-sessions",
    {
      schema: {
        tags: ["admin"],
        querystring: paginationSchema,
        response: { 200: sessionListResponseSchema },
      },
      // preValidation ensures 401/403 fires before querystring validation
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    attendanceController.getOrgSessions,
  );
}
