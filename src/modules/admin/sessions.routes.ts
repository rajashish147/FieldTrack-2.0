import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { attendanceService } from "../attendance/attendance.service.js";
import { handleError, paginated } from "../../utils/response.js";
import { supabaseServiceClient as supabase } from "../../config/supabase.js";

// ─── Query schema ─────────────────────────────────────────────────────────────

// TODO (future phase): replace offset pagination with cursor-based pagination
// to support large datasets without heavy DB scans.
const adminSessionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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

  /**
   * GET /admin/sessions/:id/locations
   *
   * Returns all GPS points recorded during a specific session, ordered by
   * recorded_at ascending (chronological playback order).
   * Scoped to the requesting admin's organization — cross-org access is
   * rejected by the org_id filter applied in the query.
   *
   * Auth: ADMIN only.
   */
  app.get(
    "/admin/sessions/:id/locations",
    {
      schema: {
        tags: ["admin"],
        params: z.object({ id: z.string().uuid() }),
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const { id: sessionId } = request.params as { id: string };
        const orgId = request.organizationId;

        const { data, error } = await supabase
          .from("gps_locations")
          .select("id, latitude, longitude, accuracy, recorded_at, sequence_number")
          .eq("session_id", sessionId)
          .eq("organization_id", orgId)
          .order("recorded_at", { ascending: true });

        if (error) throw new Error(error.message);

        reply.status(200).send({ success: true, data: data ?? [] });
      } catch (error) {
        handleError(error, request, reply, "Failed to fetch session locations");
      }
    },
  );
}
