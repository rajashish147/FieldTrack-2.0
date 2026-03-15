import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import { ok, handleError } from "../../utils/response.js";
import type { EmployeeMapMarker } from "@fieldtrack/types";

// ─── Route registration ───────────────────────────────────────────────────────

/**
 * GET /admin/monitoring/map
 *
 * Returns one marker per employee who has at least one recorded GPS point.
 * The coordinates represent the employee's most recent GPS fix (within their
 * latest session, per the employee_latest_sessions snapshot table).
 *
 * Algorithm:
 *  1. Fetch all employees for the org from employee_latest_sessions snapshot
 *     (O(employees), pre-sorted by status_priority).
 *  2. Collect their session_ids (the latest session per employee).
 *  3. Batch-query gps_locations WHERE session_id IN (...) ordered by
 *     recorded_at DESC.  Deduplicate in JS to keep only the freshest point
 *     per session.
 *  4. Merge snapshot row (name/code/status) with GPS point.
 *
 * Employees without any GPS points are omitted — they have nothing to render.
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

        // Step 1 — fetch snapshot for ACTIVE and RECENT employees only.
        // Showing all 5000+ INACTIVE employees on a live map is not useful and
        // would send thousands of session IDs in the GPS IN-clause, overflowing
        // PostgREST's URL length limit. The monitoring map shows employees who
        // are currently working or recently active.
        const { data: snapshots, error: snapError } = await supabase
          .from("employee_latest_sessions")
          .select("employee_id, organization_id, session_id, status, employees!employee_latest_sessions_employee_id_fkey(name, employee_code)")
          .eq("organization_id", orgId)
          .in("status", ["ACTIVE", "RECENT"])
          .order("status", { ascending: true });

        if (snapError) {
          throw new Error(`Map: snapshot query failed: ${snapError.message}`);
        }

        const rows = (snapshots ?? []) as unknown as Array<{
          employee_id: string;
          organization_id: string;
          session_id: string | null;
          status: string;
          employees: { name: string; employee_code: string } | null;
        }>;

        if (rows.length === 0) {
          return reply.status(200).send(ok([] as EmployeeMapMarker[]));
        }

        // Step 2 — collect non-null session ids
        const sessionIds = rows
          .map((r) => r.session_id)
          .filter((id): id is string => id !== null);

        if (sessionIds.length === 0) {
          // No sessions recorded yet — no GPS points possible
          return reply.status(200).send(ok([] as EmployeeMapMarker[]));
        }

        // Step 3 — batch-query latest GPS points for all sessions
        const { data: gpsRows, error: gpsError } = await supabase
          .from("gps_locations")
          .select("session_id, employee_id, latitude, longitude, recorded_at")
          .eq("organization_id", orgId)
          .in("session_id", sessionIds)
          .order("recorded_at", { ascending: false });

        if (gpsError) {
          throw new Error(`Map: GPS query failed: ${gpsError.message}`);
        }

        // Step 4 — deduplicate: keep the first (newest) point per session_id
        const latestBySession = new Map<
          string,
          { employee_id: string; latitude: number; longitude: number; recorded_at: string }
        >();
        for (const gps of (gpsRows ?? []) as Array<{
          session_id: string;
          employee_id: string;
          latitude: number;
          longitude: number;
          recorded_at: string;
        }>) {
          if (!latestBySession.has(gps.session_id)) {
            latestBySession.set(gps.session_id, {
              employee_id: gps.employee_id,
              latitude: gps.latitude,
              longitude: gps.longitude,
              recorded_at: gps.recorded_at,
            });
          }
        }

        // Step 5 — merge snapshot + GPS, skip employees with no GPS point
        const markers: EmployeeMapMarker[] = [];
        for (const snap of rows) {
          if (!snap.session_id) continue;
          const gps = latestBySession.get(snap.session_id);
          if (!gps) continue; // no GPS recorded in this session

          markers.push({
            employeeId: snap.employee_id,
            employeeName: snap.employees?.name ?? "Unknown",
            employeeCode: snap.employees?.employee_code ?? null,
            status: snap.status as EmployeeMapMarker["status"],
            sessionId: snap.session_id,
            latitude: gps.latitude,
            longitude: gps.longitude,
            recordedAt: gps.recorded_at,
          });
        }

        reply.status(200).send(ok(markers));
      } catch (error) {
        handleError(error, request, reply, "Unexpected error fetching map data");
      }
    },
  );
}
