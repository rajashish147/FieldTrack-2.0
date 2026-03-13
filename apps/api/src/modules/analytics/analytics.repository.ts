import { orgTable } from "../../db/query.js";
import type { FastifyRequest } from "fastify";
import type {
  MinimalSessionRow,
  MinimalExpenseRow,
  SessionWithEmployeeRow,
} from "./analytics.schema.js";

/**
 * Analytics repository — read-only queries for the analytics layer.
 *
 * Design principles:
 *  - Never select("*") — only fetch columns required for aggregation.
 *  - All queries are scoped via tenantQuery() — cross-tenant reads are impossible.
 *  - Two-query pattern for session range filtering.
 *  - Early-return empty arrays when the first query returns no rows.
 *
 * Phase 15.5 — aligned with Phase 16 migration schema:
 *   attendance_sessions: user_id → employee_id, check_in_at → checkin_at
 *   session_summaries: total_distance_meters → total_distance_km, duration_seconds → total_duration_seconds
 *   expenses: created_at filter → submitted_at
 *
 * Index dependencies:
 *   attendance_sessions(organization_id, checkin_at)           — range scan
 *   session_summaries(session_id, organization_id)             — IN lookup
 *   expenses(organization_id, submitted_at)                    — range scan
 */
export const analyticsRepository = {
  // ─── Session Helpers ──────────────────────────────────────────────────────

  /**
   * Resolve sessions within an optional date range for the requesting org.
   * Returns minimal {id, employee_id} rows — no GPS data, no full row fetches.
   *
   * Relies on index: attendance_sessions(organization_id, checkin_at)
   */
  async getSessionsInRange(
    request: FastifyRequest,
    from: string | undefined,
    to: string | undefined,
  ): Promise<MinimalSessionRow[]> {
    let query = orgTable(request, "attendance_sessions")
      .select("id, employee_id, total_distance_km, total_duration_seconds")
      .order("checkin_at", { ascending: false })
      .limit(5000);

    if (from !== undefined) {
      query = query.gte("checkin_at", from) as typeof query;
    }
    if (to !== undefined) {
      query = query.lte("checkin_at", to) as typeof query;
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Analytics: failed to fetch sessions in range: ${error.message}`);
    }
    return (data ?? []) as MinimalSessionRow[];
  },

  /**
   * Resolve sessions within an optional date range filtered to a specific employee.
   */
  async getSessionsForUser(
    request: FastifyRequest,
    employeeId: string,
    from: string | undefined,
    to: string | undefined,
  ): Promise<MinimalSessionRow[]> {
    let query = orgTable(request, "attendance_sessions")
      .select("id, employee_id, total_distance_km, total_duration_seconds")
      .eq("employee_id", employeeId)
      .order("checkin_at", { ascending: false })
      .limit(5000);

    if (from !== undefined) {
      query = query.gte("checkin_at", from) as typeof query;
    }
    if (to !== undefined) {
      query = query.lte("checkin_at", to) as typeof query;
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Analytics: failed to fetch user sessions: ${error.message}`);
    }
    return (data ?? []) as MinimalSessionRow[];
  },

  /**
   * Lightweight check — returns true if the employee has at least one attendance
   * session in the requesting org.
   */
  async checkUserHasSessionsInOrg(
    request: FastifyRequest,
    employeeId: string,
  ): Promise<boolean> {
    const { data, error } = await orgTable(request, "attendance_sessions")
      .select("id")
      .eq("employee_id", employeeId)
      .limit(1);

    if (error) {
      throw new Error(`Analytics: user validation query failed: ${error.message}`);
    }
    return (data ?? []).length > 0;
  },

  // ── Expense Helpers ──────────────────────────────────────────────────────

  /**
   * Fetch minimal expense rows (amount + status only) for the org within the
   * optional date range.
   *
   * Phase 15.5: filter column corrected: created_at → submitted_at
   *
   * Relies on index: expenses(organization_id, submitted_at)
   */
  async getExpensesInRange(
    request: FastifyRequest,
    from: string | undefined,
    to: string | undefined,
  ): Promise<MinimalExpenseRow[]> {
    let query = orgTable(request, "expenses")
      .select("amount, status");

    if (from !== undefined) {
      query = query.gte("submitted_at", from) as typeof query;
    }
    if (to !== undefined) {
      query = query.lte("submitted_at", to) as typeof query;
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Analytics: failed to fetch expenses: ${error.message}`);
    }
    return (data ?? []) as MinimalExpenseRow[];
  },

  /**
   * Count all active employees in the requesting org.
   *
   * Uses a HEAD request (no row data returned) so Postgres only executes
   * a COUNT — far cheaper than fetching rows and measuring .length.
   *
   * Relies on index: employees(organization_id)
   */
  async getActiveEmployeesCount(request: FastifyRequest): Promise<number> {
    const result = await orgTable(request, "employees")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true);

    if (result.error) {
      throw new Error(
        `Analytics: failed to count active employees: ${result.error.message}`,
      );
    }
    return result.count ?? 0;
  },

  /**
   * Same as getExpensesInRange but scoped to a specific employee_id.
   */
  async getExpensesForUser(
    request: FastifyRequest,
    employeeId: string,
    from: string | undefined,
    to: string | undefined,
  ): Promise<MinimalExpenseRow[]> {
    let query = orgTable(request, "expenses")
      .select("amount, status")
      .eq("employee_id", employeeId);

    if (from !== undefined) {
      query = query.gte("submitted_at", from) as typeof query;
    }
    if (to !== undefined) {
      query = query.lte("submitted_at", to) as typeof query;
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Analytics: failed to fetch user expenses: ${error.message}`);
    }
    return (data ?? []) as MinimalExpenseRow[];
  },

  /**
   * Fetch sessions with employee names in a single JOIN query.
   * Used exclusively for top performers — avoids a second round-trip to
   * the employees table by embedding `employees(name)` via the FK relation.
   *
   * Equivalent SQL:
   *   SELECT s.id, s.employee_id, s.total_distance_km, s.total_duration_seconds,
   *          e.name
   *   FROM   attendance_sessions s
   *   JOIN   employees e ON e.id = s.employee_id
   *   WHERE  s.organization_id = $orgId [AND checkin_at filters]
   */
  async getSessionsWithEmployeeNames(
    request: FastifyRequest,
    from: string | undefined,
    to: string | undefined,
  ): Promise<SessionWithEmployeeRow[]> {
    let query = orgTable(request, "attendance_sessions")
      .select(
        "id, employee_id, total_distance_km, total_duration_seconds, employees!attendance_sessions_employee_id_fkey(name)",
      )
      .order("checkin_at", { ascending: false });

    if (from !== undefined) {
      query = query.gte("checkin_at", from) as typeof query;
    }
    if (to !== undefined) {
      query = query.lte("checkin_at", to) as typeof query;
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(
        `Analytics: failed to fetch sessions with employee names: ${error.message}`,
      );
    }
    return (data ?? []) as SessionWithEmployeeRow[];
  },
};