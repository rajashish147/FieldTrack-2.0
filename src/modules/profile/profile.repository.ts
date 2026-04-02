import { orgTable } from "../../db/query.js";
import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import type { FastifyRequest } from "fastify";
import type { ActivityStatus } from "../../types/shared.js";

/**
 * Compute activity status from last_activity_at timestamp.
 * ACTIVE:   within 24 hours
 * RECENT:   within 7 days
 * INACTIVE: older than 7 days or null
 */
export function computeActivityStatusFromTimestamp(
  lastActivityAt: string | null,
): ActivityStatus {
  if (!lastActivityAt) return "INACTIVE";
  const ageMs = Date.now() - new Date(lastActivityAt).getTime();
  if (ageMs < 86_400_000) return "ACTIVE";          // 24h
  if (ageMs < 7 * 86_400_000) return "RECENT";      // 7 days
  return "INACTIVE";
}

export interface EmployeeRow {
  id: string;
  name: string;
  employee_code: string | null;
  phone: string | null;
  is_active: boolean;
  last_activity_at: string | null;
  created_at: string;
}

export const profileRepository = {
  /**
   * Get employee by their employee ID (employees.id).
   */
  async getEmployeeById(
    request: FastifyRequest,
    employeeId: string,
  ): Promise<EmployeeRow | null> {
    const { data, error } = await orgTable(request, "employees")
      .select("id, name, employee_code, phone, is_active, last_activity_at, created_at")
      .eq("id", employeeId)
      .limit(1)
      .single();

    if (error && error.code === "PGRST116") return null;
    if (error) throw new Error(`Profile: failed to fetch employee: ${error.message}`);
    return data as EmployeeRow;
  },

  /**
   * Get employee stats: sessions, distance, duration.
   *
   * Phase 1 optimization: Reads from employee_daily_metrics (pre-aggregated by
   * the analytics worker) instead of scanning all attendance_sessions rows.
   * For an employee with 2 years of history this is O(730 rows) vs O(sessions_count).
   */
  async getEmployeeStats(
    request: FastifyRequest,
    employeeId: string,
  ): Promise<{
    totalSessions: number;
    totalDistanceKm: number;
    totalDurationSeconds: number;
  }> {
    const { data, error } = await orgTable(request, "employee_daily_metrics")
      .select("sessions, distance_km, duration_seconds")
      .eq("employee_id", employeeId);

    if (error) {
      throw new Error(`Profile: failed to fetch session stats: ${error.message}`);
    }

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    let totalDistanceKm = 0;
    let totalDurationSeconds = 0;
    let totalSessions = 0;
    for (const row of rows) {
      totalSessions += (row.sessions as number) ?? 0;
      totalDistanceKm += (row.distance_km as number) ?? 0;
      totalDurationSeconds += (row.duration_seconds as number) ?? 0;
    }

    return {
      totalSessions,
      totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
      totalDurationSeconds,
    };
  },

  /**
   * Get employee expense stats.
   *
   * Uses two COUNT HEAD queries instead of fetching all expense rows.
   * A long-tenured employee could have hundreds of expenses; fetching them all
   * just to call .length and .filter was an unbounded O(N) row fetch on every
   * profile load.  COUNT HEAD queries are O(1) index scans that return only the
   * count — no row data is transferred over the wire.
   */
  async getEmployeeExpenseStats(
    request: FastifyRequest,
    employeeId: string,
  ): Promise<{ expensesSubmitted: number; expensesApproved: number }> {
    const [submittedResult, approvedResult] = await Promise.all([
      orgTable(request, "expenses")
        .select("id", { count: "exact", head: true })
        .eq("employee_id", employeeId),
      orgTable(request, "expenses")
        .select("id", { count: "exact", head: true })
        .eq("employee_id", employeeId)
        .eq("status", "APPROVED"),
    ]);

    if (submittedResult.error) {
      throw new Error(`Profile: failed to fetch expense submitted count: ${submittedResult.error.message}`);
    }
    if (approvedResult.error) {
      throw new Error(`Profile: failed to fetch expense approved count: ${approvedResult.error.message}`);
    }

    return {
      expensesSubmitted: submittedResult.count ?? 0,
      expensesApproved: approvedResult.count ?? 0,
    };
  },

  /**
   * Update last_activity_at for an employee.
   */
  async updateLastActivity(
    request: FastifyRequest,
    employeeId: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await orgTable(request, "employees")
      .update({ last_activity_at: now })
      .eq("id", employeeId);

    if (error) {
      // Non-critical — log and continue rather than failing the request
      request.log.warn(
        { employeeId, error: error.message },
        "Failed to update last_activity_at",
      );
    }
  },

  /**
   * feat-1: Read the precomputed cumulative metrics snapshot for an employee.
   *
   * Returns null when the snapshot row doesn't exist yet (e.g. the first
   * few seconds after a new employee's first check-in).  Callers fall back
   * to the legacy employee_daily_metrics aggregation in that case.
   *
   * Uses the service-role client so this method is also safe to call from
   * admin contexts where the RLS-bound orgTable might reject the read.
   */
  async getMetricsSnapshot(
    employeeId: string,
    organizationId: string,
  ): Promise<{
    totalSessions: number;
    totalDistanceKm: number;
    totalDurationSeconds: number;
    totalExpenses: number;
    lastActiveAt: string | null;
  } | null> {
    const { data, error } = await supabase
      .from("employee_metrics_snapshot")
      .select("total_sessions, total_hours, total_distance, total_expenses, last_active_at")
      .eq("employee_id", employeeId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (error) {
      // Non-fatal: fall through to daily_metrics aggregation
      return null;
    }
    if (!data) return null;

    const row = data as {
      total_sessions: number;
      total_hours: number;
      total_distance: number;
      total_expenses: number;
      last_active_at: string | null;
    };

    return {
      totalSessions:         row.total_sessions ?? 0,
      // total_hours is stored as hours; callers expect totalDurationSeconds
      totalDurationSeconds:  Math.round((row.total_hours ?? 0) * 3600),
      totalDistanceKm:       row.total_distance ?? 0,
      totalExpenses:         row.total_expenses ?? 0,
      lastActiveAt:          row.last_active_at,
    };
  },
};
