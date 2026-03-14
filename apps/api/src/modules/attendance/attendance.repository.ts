import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import { orgTable } from "../../db/query.js";
import { applyPagination } from "../../utils/pagination.js";
import type { FastifyRequest, FastifyBaseLogger } from "fastify";
import type { AttendanceSession } from "./attendance.schema.js";
import type { ActivityStatus } from "@fieldtrack/types";

/** Enriched session returned by list queries — adds employee info and activityStatus. */
export type EnrichedAttendanceSession = AttendanceSession & {
  employee_code: string | null;
  employee_name: string | null;
  activityStatus: ActivityStatus;
};

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
 * Maps a raw employee_latest_sessions row to the EnrichedAttendanceSession DTO.
 * Single source of truth for snapshot → API field mapping:
 *   session_id  → id
 *   status      → activityStatus
 *   updated_at  → created_at (snapshot has no created_at column)
 */
export function mapLatestSessionRow(row: Record<string, unknown>): EnrichedAttendanceSession {
  return {
    id: row.session_id as string | null,
    employee_id: row.employee_id as string,
    organization_id: row.organization_id as string,
    checkin_at: row.checkin_at as string,
    checkout_at: (row.checkout_at as string | null) ?? null,
    total_distance_km: (row.total_distance_km as number | null) ?? null,
    total_duration_seconds: (row.total_duration_seconds as number | null) ?? null,
    distance_recalculation_status: (row.distance_recalculation_status as string | null) ?? null,
    created_at: row.updated_at as string,
    updated_at: row.updated_at as string,
    employee_code: (row.employee_code as string | null) ?? null,
    employee_name: (row.employee_name as string | null) ?? null,
    activityStatus: row.status as ActivityStatus,
  } as EnrichedAttendanceSession;
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
   * Joins employees to include employee_code, employee_name, and activityStatus.
   */
  async findSessionsByUser(
    request: FastifyRequest,
    employeeId: string,
    page: number,
    limit: number,
  ): Promise<{ data: EnrichedAttendanceSession[]; total: number }> {
    const { data, error, count } = await applyPagination(
      orgTable(request, "attendance_sessions")
        .select("id, employee_id, organization_id, checkin_at, checkout_at, distance_recalculation_status, total_distance_km, total_duration_seconds, created_at, updated_at, employees!attendance_sessions_employee_id_fkey(name, employee_code)", { count: "exact" })
        .eq("employee_id", employeeId)
        .order("checkin_at", { ascending: false }),
      page,
      limit,
    );

    if (error) {
      throw new Error(`Failed to fetch user sessions: ${error.message}`);
    }

    const mapped = ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
      const emp = row.employees as { name?: string; employee_code?: string } | null;
      const { employees: _emp, ...rest } = row;
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
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safeOffset = (Math.max(1, page) - 1) * safeLimit;

    let query = supabase
      .from("employee_latest_sessions")
      .select("*", { count: "exact" })
      .eq("organization_id", request.organizationId);

    if (status !== "all") {
      query = query.eq("status", status.toUpperCase());
    }

    const { data, error, count } = await query
      .order("status_priority", { ascending: true })
      .order("updated_at", { ascending: false })
      .range(safeOffset, safeOffset + safeLimit - 1);

    if (error) {
      throw new Error(`Failed to fetch latest sessions per employee: ${error.message}`);
    }

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    return { data: rows.map(mapLatestSessionRow), total: count ?? 0 };
  },

  /**
   * Upsert the employee_latest_sessions snapshot row for one employee.
   * Called on check-in and check-out.  Delegates status/priority derivation
   * and employee name lookup to the upsert_employee_latest_session DB function
   * so that logic stays in one place.
   * Fire-and-forget safe — caller may choose not to await.
   */
  async upsertLatestSession(
    organizationId: string,
    employeeId: string,
    session: AttendanceSession,
  ): Promise<void> {
    const { error } = await supabase.rpc("upsert_employee_latest_session", {
      p_session_id: session.id,
      p_organization_id: organizationId,
      p_employee_id: employeeId,
      p_checkin_at: session.checkin_at,
      p_checkout_at: session.checkout_at ?? null,
      p_total_distance_km: session.total_distance_km ?? null,
      p_total_duration_seconds: session.total_duration_seconds ?? null,
      p_distance_recalculation_status: session.distance_recalculation_status ?? "pending",
    });
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
        distance_recalculation_status: "done",
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
      const { employees: _emp, ...rest } = row;
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
    // Hard cap on sessions scanned per recovery run.
    const RECOVERY_SCAN_LIMIT = 500;

    const { data, error } = await supabase
      .from("attendance_sessions")
      .select(
        `
                id,
                checkout_at,
                session_summaries (
                    computed_at
                )
            `,
      )
      .not("checkout_at", "is", null)
      .order("checkout_at", { ascending: true })
      .limit(RECOVERY_SCAN_LIMIT);

    if (error) {
      log.error({ error: error.message }, "Recovery scan query failed");
      return [];
    }

    if (!data) return [];

    const requiresRecalculation: { id: string }[] = [];

    for (const row of data) {
      const summaries = Array.isArray(row.session_summaries)
        ? row.session_summaries
        : row.session_summaries
          ? [row.session_summaries]
          : [];

      const summary = summaries[0] as { computed_at: string } | undefined;
      const checkoutAt = row.checkout_at as string;

      if (!summary) {
        requiresRecalculation.push({ id: row.id });
      } else if (
        new Date(summary.computed_at).getTime() < new Date(checkoutAt).getTime()
      ) {
        requiresRecalculation.push({ id: row.id });
      }
    }

    log.info(
      {
        scanned: data.length,
        needsRecalculation: requiresRecalculation.length,
      },
      "Recovery scan complete",
    );

    return requiresRecalculation;
  },
};
