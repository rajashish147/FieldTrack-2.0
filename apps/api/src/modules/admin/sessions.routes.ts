import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { attendanceService } from "../attendance/attendance.service.js";
import { handleError, paginated } from "../../utils/response.js";

// ─── Query schema ─────────────────────────────────────────────────────────────

const adminSessionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  status: z.enum(["all", "active", "recent", "inactive"]).default("all"),
  /** Filter by employee UUID — returns full attendance_sessions history for that employee. */
  employee_id: z.string().uuid().optional(),
});

// ─── Route registration ───────────────────────────────────────────────────────

/**
 * Admin sessions routes — ADMIN-only endpoints that read from the
 * employee_latest_sessions snapshot table (O(employees) read complexity).
 */
export async function adminSessionsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /admin/sessions
   *
   * Returns one row per employee — the employee's latest session — ordered by
   * status_priority (ACTIVE → RECENT → INACTIVE) then updated_at DESC.
   *
   * Performance: O(employees) via snapshot table, not O(sessions).
   * Typical response time: <100 ms for 5 000+ employee organizations.
   */
  app.get(
    "/admin/sessions",
    {
      schema: {
        tags: ["admin"],
        querystring: adminSessionsQuerySchema,
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const parsed = adminSessionsQuerySchema.parse(request.query);
        const t0 = Date.now();
        const result = await attendanceService.getOrgSessions(
          request,
          parsed.page,
          parsed.limit,
          parsed.status,
          parsed.employee_id,
        );
        const durationMs = Date.now() - t0;
        if (durationMs > 100) {
          request.log.warn(
            { route: "/admin/sessions", queryName: "getOrgSessions", durationMs },
            "slow DB query",
          );
        }
        reply
          .status(200)
          .send(paginated(result.data, parsed.page, parsed.limit, result.total));
      } catch (error) {
        handleError(error, request, reply, "Unexpected error fetching admin sessions");
      }
    },
  );
}
