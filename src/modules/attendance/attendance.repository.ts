import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import { orgTable } from "../../db/query.js";
import { applyPagination } from "../../utils/pagination.js";
import type { FastifyRequest, FastifyBaseLogger } from "fastify";
import type { AttendanceSession } from "./attendance.schema.js";
import type { ActivityStatus, SessionDTO } from "../../types/shared.js";

/**
 * Enriched session returned by list queries — re-exported as SessionDTO.
 * Kept as an alias so existing imports continue to work without a mass rename.
 */
export type EnrichedAttendanceSession = SessionDTO;

/**
 * Computes the activity status of a session based on its checkout timestamp.
 * - ACTIVE:   no checkout yet
 * - RECENT:   checked out within the last 24 hours
 * - INACTIVE: checked out more than 24 hours ago
 */
function computeActivityStatus(checkoutAt: string | null): ActivityStatus {
  if (checkoutAt === null) return "ACTIVE";
  const ageMs = Date.now() - new Date(checkoutAt).getTime();
  return ageMs < 86_400_000 ? "RECENT" : "INACTIVE";
}

/**
 * Attendance repository — all Supabase queries for attendance_sessions.
 * Every query is scoped via tenantQuery() for tenant isolation.
 * tenantQuery() is always called BEFORE terminal operations (.single/.range).
 *
 * Phase 15.5 — column names aligned with Phase 16 migration schema:
 *   user_id       → employee_id
 *   check_in_at   → checkin_at
 *   check_out_at  → checkout_at
 */
/**
 * Maps a raw employee_latest_sessions row to the SessionDTO.
 * Single source of truth for snapshot → API field mapping:
 *   session_id  → id
 *   status      → activityStatus
 *   updated_at  → created_at (snapshot has no created_at column)
 *
 * Returns a SessionDTO — database rows never leak directly to the API.
 */
export function mapLatestSessionRow(row: Record<string, unknown>): SessionDTO {
  // Production schema uses `latest_checkin` / `latest_checkout`.
  // Migration schema uses `checkin_at` / `checkout_at`.
  // Support both so the mapper works against either environment.
  const checkinAt = (row.latest_checkin ?? row.checkin_at ?? row.updated_at) as string | null;
  const checkoutAt = (row.latest_checkout ?? row.checkout_at) as string | null;
  // When the query joins employees via FK, Supabase returns a nested object.
  // Fall back to flat columns so the mapper works in both test stubs and live.
  const emp = row.employees as { name?: string; employee_code?: string } | null;
  return {
    id: (row.session_id as string | null) ?? null,
    employee_id: row.employee_id as string,
    organization_id: row.organization_id as string,
    checkin_at: checkinAt ?? (row.updated_at as string),
    checkout_at: checkoutAt,
    total_distance_km: (row.total_distance_km as number | null) ?? null,
    total_duration_seconds: (row.total_duration_seconds as number | null) ?? null,
    // distance_recalculation_status is not in the authoritative production schema;
    // always null on snapshot rows to prevent serialization errors.
    distance_recalculation_status: null,
    created_at: checkinAt ?? (row.updated_at as string),
    updated_at: row.updated_at as string,
    employee_code: (row.employee_code as string | null) ?? emp?.employee_code ?? null,
    employee_name: (row.employee_name as string | null) ?? emp?.name ?? null,
    activityStatus: row.status as ActivityStatus,
  };
}

export const attendanceRepository = {
  /**
   * Find an open session (no checkout_at) for a specific employee.
   */
  async findOpenSession(
    request: FastifyRequest,
    employeeId: string,
  ): Promise<AttendanceSession | null> {
    const { data, error } = await orgTable(request, "attendance_sessions")
      .select("id, employee_id, organization_id, checkin_at, checkout_at, distance_recalculation_status, total_distance_km, total_duration_seconds, created_at, updated_at")
      .eq("employee_id", employeeId)
      .is("checkout_at", null)
      .limit(1)
      .single();

    // PGRST116 = no rows found — not an error for our use case
    if (error && error.code === "PGRST116") {
      return null;
    }
    if (error) {
      throw new Error(`Failed to find open session: ${error.message}`);
    }
    return data as AttendanceSession;
  },

  /**
   * Exact lookup to validate that a specific session belongs to the employee and is still active.
   */
  async validateSessionActive(
    request: FastifyRequest,
    sessionId: string,
    employeeId: string,
  ): Promise<boolean> {
    const { data, error } = await orgTable(request, "attendance_sessions")
      .select("id")
      .eq("id", sessionId)
      .eq("employee_id", employeeId)
      .is("checkout_at", null)
      .limit(1)
      .single();

    if (error && error.code === "PGRST116") {
      return false;
    }
    if (error) {
      throw new Error(`Failed to validate session: ${error.message}`);
    }
    return !!data;
  },

  /**
   * Returns the checkin_at timestamp for an active session.
   * Used by the locations service to reject GPS points recorded before the
   * session started (replay / clock-skew guard).
   * Returns null if the session is not found in the org (should not occur in
   * practice after validateSessionActive has already confirmed the session).
   */
  async getSessionCheckinAt(
    request: FastifyRequest,
    sessionId: string,
  ): Promise<string | null> {
    const { data, error } = await orgTable(request, "attendance_sessions")
      .select("checkin_at")
      .eq("id", sessionId)
      .is("checkout_at", null)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to fetch session checkin time: ${error.message}`);
    }
    return (data as { checkin_at: string } | null)?.checkin_at ?? null;
  },

  /**
   * Check whether an active employee exists within the requesting organization.
   * Used by the service layer to provide a clear error before hitting DB constraints.
   */
  async findEmployeeInOrg(
    request: FastifyRequest,
    employeeId: string,
  ): Promise<boolean> {
    const { data, error } = await orgTable(request, "employees")
      .select("id")
      .eq("id", employeeId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (error && error.code !== "PGRST116") {
      throw new Error(`Failed to validate employee: ${error.message}`);
    }
    return data !== null;
  },

  /**
   * Create a new check-in session.
   * Insert doesn't need tenantQuery() — we explicitly set organization_id.
   */
  async createSession(
    request: FastifyRequest,
    employeeId: string,
  ): Promise<AttendanceSession> {
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("attendance_sessions")
      .insert({
        employee_id: employeeId,
        organization_id: request.organizationId,
        checkin_at: now,
      })
      .select("id, employee_id, organization_id, checkin_at, checkout_at, distance_recalculation_status, total_distance_km, total_duration_seconds, created_at, updated_at")
      .single();

    if (error) {
      throw new Error(`Failed to create session: ${error.message}`);
    }
    return data as AttendanceSession;
  },

  /**
   * Close an open session by setting checkout_at.
   */
  async closeSession(
    request: FastifyRequest,
    sessionId: string,
  ): Promise<AttendanceSession> {
    const now = new Date().toISOString();

    const { data, error } = await orgTable(request, "attendance_sessions")
      .update({ checkout_at: now })
      .eq("id", sessionId)
      .select("id, employee_id, organization_id, checkin_at, checkout_at, distance_recalculation_status, total_distance_km, total_duration_seconds, created_at, updated_at")
      .single();

    if (error) {
      throw new Error(`Failed to close session: ${error.message}`);
    }
    return data as AttendanceSession;
  },

  /**
   * Get all sessions for a specific employee (employee's own sessions).
   * Paginated, ordered by checkin_at DESC. employee_name/employee_code are null
   * (caller already knows their own identity — no join needed).
   */
  async findSessionsByUser(
    request: FastifyRequest,
    employeeId: string,
    page: number,
    limit: number,
  ): Promise<{ data: EnrichedAttendanceSession[]; total: number }> {
    // Phase 30: removed employees join (employee knows their own identity) and
    // distance_recalculation_status (always null, not used by frontend).
    // count:"estimated" eliminates the shadow SELECT COUNT(*) on every list call.
    const { data, error, count } = await applyPagination(
      orgTable(request, "attendance_sessions")
        .select(
          "id, employee_id, organization_id, checkin_at, checkout_at, total_distance_km, total_duration_seconds, created_at, updated_at",
          { count: "estimated" },
        )
        .eq("employee_id", employeeId)
        .order("checkin_at", { ascending: false }),
      page,
      limit,
    );

    if (error) {
      throw new Error(`Failed to fetch user sessions: ${error.message}`);
    }

    const mapped = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: row.id as string,
      employee_id: row.employee_id as string,
      organization_id: row.organization_id as string,
      checkin_at: row.checkin_at as string,
      checkout_at: row.checkout_at as string | null,
      total_distance_km: row.total_distance_km as number | null,
      total_duration_seconds: row.total_duration_seconds as number | null,
      distance_recalculation_status: null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      employee_name: null,
      employee_code: null,
      activityStatus: computeActivityStatus(row.checkout_at as string | null),
    } as EnrichedAttendanceSession));
    return { data: mapped, total: count ?? 0 };
  },

  /**
   * Get the latest session per employee for the entire organization (admin view).
   * Reads from the employee_latest_sessions snapshot table — O(employees) instead
   * of a window-function scan over all attendance_sessions rows.
   * Sorting: ACTIVE (1) → RECENT (2) → INACTIVE (3), then newest updated_at first.
   */
  async findLatestSessionPerEmployee(
    request: FastifyRequest,
    page: number,
    limit: number,
    status: string = "all",
  ): Promise<{ data: EnrichedAttendanceSession[]; total: number }> {
    const safeLimit = Math.min(1000, Math.max(1, limit));
    const safeOffset = (Math.max(1, page) - 1) * safeLimit;

    // Join employees via FK so employee_name and employee_code are always present.
    // Phase 30: count:"estimated" eliminates the shadow SELECT COUNT(*) query.
    let query = supabase
      .from("employee_latest_sessions")
      .select(
        "employee_id, organization_id, session_id, latest_checkin, latest_checkout, total_distance_km, total_duration_seconds, status, updated_at, employees!employee_latest_sessions_employee_id_fkey(name, employee_code)",
        { count: "estimated" },
      )
      .eq("organization_id", request.organizationId);

    if (status !== "all") {
      query = query.eq("status", status.toUpperCase());
    }

    const t0 = Date.now();
    const { data, error, count } = await query
      // Production schema has no status_priority column; order by updated_at only
      // and re-sort in JS to guarantee ACTIVE → RECENT → INACTIVE ordering.
      .order("updated_at", { ascending: false })
      .range(safeOffset, safeOffset + safeLimit - 1);
    const durationMs = Date.now() - t0;
    if (durationMs > 100) {
      request.log.warn(
        { route: "/admin/sessions", queryName: "findLatestSessionPerEmployee", durationMs },
        "slow query",
      );
    }

    if (error) {
      throw new Error(`Failed to fetch latest sessions per employee: ${error.message}`);
    }

    const rows = (data ?? []) as Array<Record<string, unknown>>;

    // Re-sort: ACTIVE (1) → RECENT (2) → INACTIVE (3), then newest updated_at first.
    const statusPriority = (s: unknown): number =>
      s === "ACTIVE" ? 1 : s === "RECENT" ? 2 : 3;
    rows.sort((a, b) => {
      const diff = statusPriority(a.status) - statusPriority(b.status);
      if (diff !== 0) return diff;
      return (
        new Date(b.updated_at as string).getTime() -
        new Date(a.updated_at as string).getTime()
      );
    });

    return { data: rows.map(mapLatestSessionRow), total: count ?? 0 };
  },

  /**
   * Upsert the employee_latest_sessions snapshot row for one employee.
   * Called on check-in and check-out as belt-and-suspenders alongside the
   * DB trigger (trg_update_employee_latest_session) that fires on
   * attendance_sessions INSERT/UPDATE.
   * Fire-and-forget safe — caller may choose not to await.
   *
   * Previously called supabase.rpc("upsert_employee_latest_session") which
   * does not exist in the current DB schema. Now uses a direct upsert so the
   * application path is consistent with the trigger logic.
   */
  async upsertLatestSession(
    organizationId: string,
    employeeId: string,
    session: AttendanceSession,
  ): Promise<void> {
    const ageMs = session.checkout_at
      ? Date.now() - new Date(session.checkout_at).getTime()
      : null;
    const status =
      session.checkout_at === null
        ? "ACTIVE"
        : ageMs !== null && ageMs < 86_400_000
          ? "RECENT"
          : "INACTIVE";

    const { error } = await supabase
      .from("employee_latest_sessions")
      .upsert(
        {
          employee_id: employeeId,
          organization_id: organizationId,
          session_id: session.id,
          latest_checkin: session.checkin_at,
          latest_checkout: session.checkout_at ?? null,
          total_distance_km: session.total_distance_km ?? null,
          total_duration_seconds: session.total_duration_seconds ?? null,
          status,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "employee_id" },
      );
    if (error) {
      throw new Error(`Failed to upsert latest session snapshot: ${error.message}`);
    }
  },

  /**
   * Update only the distance/duration columns on the snapshot row for a given
   * session_id.  Called after distance recalculation completes.
   * Fire-and-forget safe — caller may choose not to await.
   */
  async updateLatestSessionDistance(
    sessionId: string,
    totalDistanceKm: number,
    totalDurationSeconds: number,
  ): Promise<void> {
    const { error } = await supabase
      .from("employee_latest_sessions")
      .update({
        total_distance_km: totalDistanceKm,
        total_duration_seconds: totalDurationSeconds,
        // distance_recalculation_status omitted — not in the authoritative production schema.
        updated_at: new Date().toISOString(),
      })
      .eq("session_id", sessionId);
    if (error) {
      throw new Error(`Failed to update latest session distance snapshot: ${error.message}`);
    }
  },

  /**
   * Get all sessions for the entire organization (admin view).
   * Joins with employees to include employee_code, employee_name, and activityStatus.
   */
  async findSessionsByOrg(
    request: FastifyRequest,
    page: number,
    limit: number,
  ): Promise<{ data: EnrichedAttendanceSession[]; total: number }> {
    const query = orgTable(request, "attendance_sessions")
      .select(
        "id, employee_id, organization_id, checkin_at, checkout_at, distance_recalculation_status, total_distance_km, total_duration_seconds, created_at, updated_at, employees!attendance_sessions_employee_id_fkey(name, employee_code)",
        { count: "exact" },
      )
      .order("checkin_at", { ascending: false });

    const { data, error, count } = await applyPagination(query, page, limit);

    if (error) {
      throw new Error(`Failed to fetch org sessions: ${error.message}`);
    }

    const mapped = ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
      const emp = row.employees as { name?: string; employee_code?: string } | null;
      const { employees: _, ...rest } = row;
      return {
        ...rest,
        employee_name: emp?.name ?? null,
        employee_code: emp?.employee_code ?? null,
        activityStatus: computeActivityStatus(rest.checkout_at as string | null),
      } as EnrichedAttendanceSession;
    });
    return { data: mapped, total: count ?? 0 };
  },

  /**
   * Fetch a session exactly by ID for recalculation tasks.
   * Still respects tenant isolation implicitly via enforceTenant.
   */
  async getSessionById(
    request: FastifyRequest,
    sessionId: string,
  ): Promise<AttendanceSession | null> {
    const { data, error } = await orgTable(request, "attendance_sessions")
      .select("id, employee_id, organization_id, checkin_at, checkout_at, distance_recalculation_status, total_distance_km, total_duration_seconds, created_at, updated_at")
      .eq("id", sessionId)
      .single();

    if (error && error.code === "PGRST116") {
      return null;
    }
    if (error) {
      throw new Error(`Failed to fetch session: ${error.message}`);
    }
    return data as AttendanceSession;
  },

  /**
   * Phase 7.5 — Crash Recovery & Self-Healing.
   *
   * Selects the minimal columns required to identify orphaned sessions.
   * Runs against the service role key — intentionally bypasses RLS to
   * sweep all tenant partitions in a single bootstrap scan.
   *
   * Phase 15.5 — column names updated:
   *   check_out_at → checkout_at
   */
  /**
   * Resolve a user's employee record ID from their auth user ID.
   * employees.id (PK) ≠ users.id — this bridge is required before any query
   * that filters by employee_id using the JWT sub claim.
   */
  async findEmployeeIdByUserId(
    request: FastifyRequest,
    userId: string,
  ): Promise<string | null> {
    const { data, error } = await orgTable(request, "employees")
      .select("id")
      .eq("user_id", userId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (error && error.code !== "PGRST116") {
      throw new Error(`Failed to resolve employee: ${error.message}`);
    }

    return data?.id ?? null;
  },

  async findSessionsNeedingRecalculation(
    log: FastifyBaseLogger,
  ): Promise<{ id: string }[]> {
    const PAGE_SIZE = 500;
    const MAX_SCAN = 5000;
    let offset = 0;
    let scanned = 0;
    const requiresRecalculation: { id: string }[] = [];

    while (scanned < MAX_SCAN) {
      const { data, error } = await supabase
        .from("attendance_sessions")
        .select("id, created_at, distance_recalculation_status")
        .not("checkout_at", "is", null)
        .in("distance_recalculation_status", ["pending", "failed"])
        .order("created_at", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        log.error({ error: error.message, offset }, "Recovery scan query failed");
        break;
      }

      const rows = data ?? [];
      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        requiresRecalculation.push({ id: row.id as string });
      }

      scanned += rows.length;
      offset += rows.length;
      if (rows.length < PAGE_SIZE) {
        break;
      }
    }

    log.info(
      {
        scanned,
        needsRecalculation: requiresRecalculation.length,
      },
      "Recovery scan complete",
    );

    return requiresRecalculation;
  },
};
