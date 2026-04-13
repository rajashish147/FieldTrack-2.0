import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { attendanceController } from "./attendance.controller.js";
import { sessionSummaryController } from "../session_summary/session_summary.controller.js";
import { paginationSchema } from "./attendance.schema.js";

// ─── Shared response schema ────────────────────────────────────────────────────

/** Shape of an attendance_sessions row as returned by the API. */
const sessionResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    id: z.string().uuid(),
    employee_id: z.string().uuid(),
    organization_id: z.string().uuid(),
    checkin_at: z.string(),
    checkout_at: z.string().nullable(),
    total_distance_km: z.number().nullable(),
    total_duration_seconds: z.number().nullable(),
    distance_recalculation_status: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  }).passthrough(),
});

/**
 * Attendance routes — all endpoints require authentication.
 * ADMIN-only routes use the requireRole middleware.
 */
export async function attendanceRoutes(app: FastifyInstance): Promise<void> {
  // Check in — EMPLOYEE only (ADMIN cannot participate in attendance)
  app.post(
    "/attendance/check-in",
    {
      schema: {
        tags: ["attendance"],
        summary: "Check in (start a new attendance session)",
        description:
          "Creates a new open attendance session for the authenticated employee. " +
          "No request body required — identity is resolved from the JWT. " +
          "Returns 409 if the employee already has an open session.",
        response: { 201: sessionResponseSchema.describe("Created attendance session") },
      },
      preValidation: [authenticate, requireRole("EMPLOYEE")],
    },
    attendanceController.checkIn,
  );

  // Check out — EMPLOYEE only (ADMIN cannot participate in attendance)
  app.post(
    "/attendance/check-out",
    {
      schema: {
        tags: ["attendance"],
        summary: "Check out (close the current attendance session)",
        description:
          "Closes the employee's current open session and enqueues distance/analytics jobs. " +
          "No request body required — identity is resolved from the JWT. " +
          "Returns 409 if there is no open session to close.",
        response: { 200: sessionResponseSchema.describe("Closed attendance session") },
      },
      preValidation: [authenticate, requireRole("EMPLOYEE")],
    },
    attendanceController.checkOut,
  );

  // Recalculate distance and duration explicitly.
  // Rate-limited per IP to prevent recalculation flooding.
  app.post<{ Params: { sessionId: string } }>(
    "/attendance/:sessionId/recalculate",
    {
      schema: { tags: ["attendance"] },
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
      },
      // preValidation ensures 401 fires before querystring validation
      preValidation: [authenticate],
    },
    attendanceController.getMySessions,
  );

  // Org sessions — DEPRECATED (MIN2)
  // This route was replaced by GET /admin/sessions in Phase 16.
  // Returns 410 Gone so clients receive a clear signal to migrate.
  app.get(
    "/attendance/org-sessions",
    {
      schema: {
        tags: ["deprecated"],
        description: "Removed: use GET /admin/sessions instead.",
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      reply.status(410).send({
        success: false,
        error: "GET /attendance/org-sessions has been removed. Use GET /admin/sessions instead.",
      });
    },
  );
}
