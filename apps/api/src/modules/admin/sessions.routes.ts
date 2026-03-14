import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { attendanceService } from "../attendance/attendance.service.js";
import { handleError, paginated } from "../../utils/response.js";

// ─── Query schema ─────────────────────────────────────────────────────────────

const adminSessionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(["all", "active", "recent", "inactive"]).default("all"),
  /** Filter by employee UUID — returns full attendance_sessions history for that employee. */
  employee_id: z.string().uuid().optional(),
});

// ─── Response schema ─────────────────────────────────────────────────────────

const snapshotItemSchema = z.object({
  id: z.string().nullable(),
  employee_id: z.string(),
  organization_id: z.string(),
  checkin_at: z.string(),
  checkout_at: z.string().nullable(),
  total_distance_km: z.number().nullable(),
  total_duration_seconds: z.number().nullable(),
  distance_recalculation_status: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  employee_code: z.string().nullable().optional(),
  employee_name: z.string().nullable().optional(),
  activityStatus: z.enum(["ACTIVE", "RECENT", "INACTIVE"]),
});

const paginationMetaSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
});

const snapshotListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(snapshotItemSchema),
  pagination: paginationMetaSchema,
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
        response: {
          200: snapshotListResponseSchema.describe(
            "Latest session per employee (snapshot table)",
          ),
        },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const parsed = adminSessionsQuerySchema.parse(request.query);
        const result = await attendanceService.getOrgSessions(
          request,
          parsed.page,
          parsed.limit,
          parsed.status,
          parsed.employee_id,
        );
        reply
          .status(200)
          .send(paginated(result.data, parsed.page, parsed.limit, result.total));
      } catch (error) {
        handleError(error, request, reply, "Unexpected error fetching admin sessions");
      }
    },
  );
}
