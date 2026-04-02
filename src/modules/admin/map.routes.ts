import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import { ok, handleError } from "../../utils/response.js";
import type { EmployeeMapMarker } from "../../types/shared.js";

/** Hard safety cap — prevents map from crashing if the org scales rapidly. */
const MAX_MAP_EMPLOYEES = 1000;

// ─── Row shape returned by the get_active_map_markers RPC function ────────────
interface MapMarkerRow {
  employee_id: string;
  latitude: number;
  longitude: number;
  recorded_at: string;
  employee_name: string;
  employee_code: string | null;
  status: string;
  session_id: string | null;
}

// ─── Route registration ───────────────────────────────────────────────────────

/**
 * GET /admin/monitoring/map
 *
 * Returns one marker per ACTIVE/RECENT employee who has at least one GPS point.
 * Uses the `get_active_map_markers` Postgres function which performs a single
 * DISTINCT ON join:
 *
 *   SELECT DISTINCT ON (g.employee_id)
 *     g.employee_id, g.latitude, g.longitude, g.recorded_at,
 *     e.name, e.employee_code, els.status, els.session_id
 *   FROM gps_locations g
 *   JOIN employee_latest_sessions els ON els.employee_id = g.employee_id ...
 *   JOIN employees e ON e.id = g.employee_id
 *   WHERE g.organization_id = ? AND els.status IN ('ACTIVE','RECENT')
 *   ORDER BY g.employee_id, g.recorded_at DESC
 *   LIMIT 1000
 *
 * This replaces the previous two-query approach (snapshot + IN-clause GPS)
 * which overflowed PostgREST URL limits at scale.
 */
export async function adminMapRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/admin/monitoring/map",
    {
      schema: {
        tags: ["admin"],
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const orgId = request.organizationId;

        // Single DISTINCT ON join via Postgres function — O(active employees)
        // with no large IN-clause; uses idx_latest_sessions_active partial index.
        const queryStart = Date.now();
        const { data, error } = await supabase.rpc("get_active_map_markers", {
          p_org_id: orgId,
          p_limit: MAX_MAP_EMPLOYEES,
        });
        const durationMs = Date.now() - queryStart;

        if (durationMs > 100) {
          request.log.warn(
            { route: "/admin/monitoring/map", queryName: "get_active_map_markers", table: "gps_locations", durationMs },
            "slow DB query",
          );
        }

        if (error) {
          throw new Error(`Map: RPC query failed: ${error.message}`);
        }

        const rows = (data ?? []) as MapMarkerRow[];

        // Safety warning if we hit the cap
        if (rows.length >= MAX_MAP_EMPLOYEES) {
          request.log.warn(
            { orgId, count: rows.length, limit: MAX_MAP_EMPLOYEES },
            "Map marker limit reached — some active employees may be hidden",
          );
        }

        const markers: EmployeeMapMarker[] = rows.map((row) => ({
          employeeId: row.employee_id,
          employeeName: row.employee_name ?? "Unknown",
          employeeCode: row.employee_code ?? null,
          status: row.status as EmployeeMapMarker["status"],
          sessionId: row.session_id ?? null,
          latitude: row.latitude,
          longitude: row.longitude,
          recordedAt: row.recorded_at,
        }));

        reply.status(200).send(ok(markers));
      } catch (error) {
        handleError(error, request, reply, "Unexpected error fetching map data");
      }
    },
  );
}
