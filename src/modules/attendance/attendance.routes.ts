import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { attendanceController } from "./attendance.controller.js";
import { sessionSummaryController } from "../session_summary/session_summary.controller.js";
import { paginationSchema } from "./attendance.schema.js";

/**
 * Attendance routes — all endpoints require authentication.
 * ADMIN-only routes use the requireRole middleware.
 */
export async function attendanceRoutes(app: FastifyInstance): Promise<void> {
  // Check in — EMPLOYEE only (ADMIN cannot participate in attendance)
  app.post(
    "/attendance/check-in",
    {
      schema: { tags: ["attendance"] },
      preValidation: [authenticate, requireRole("EMPLOYEE")],
    },
    attendanceController.checkIn,
  );

  // Check out — EMPLOYEE only (ADMIN cannot participate in attendance)
  app.post(
    "/attendance/check-out",
    {
      schema: { tags: ["attendance"] },
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
