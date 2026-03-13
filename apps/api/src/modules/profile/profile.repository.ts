import { orgTable } from "../../db/query.js";
import type { FastifyRequest } from "fastify";
import type { ActivityStatus } from "@fieldtrack/types";

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
   * Get employee stats: sessions, distance, duration from attendance_sessions.
   */
  async getEmployeeStats(
    request: FastifyRequest,
    employeeId: string,
  ): Promise<{
    totalSessions: number;
    totalDistanceKm: number;
    totalDurationSeconds: number;
  }> {
    const { data, error } = await orgTable(request, "attendance_sessions")
      .select("total_distance_km, total_duration_seconds")
      .eq("employee_id", employeeId);

    if (error) {
      throw new Error(`Profile: failed to fetch session stats: ${error.message}`);
    }

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    let totalDistanceKm = 0;
    let totalDurationSeconds = 0;
    for (const row of rows) {
      totalDistanceKm += (row.total_distance_km as number) ?? 0;
      totalDurationSeconds += (row.total_duration_seconds as number) ?? 0;
    }

    return {
      totalSessions: rows.length,
      totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
      totalDurationSeconds,
    };
  },

  /**
   * Get employee expense stats.
   */
  async getEmployeeExpenseStats(
    request: FastifyRequest,
    employeeId: string,
  ): Promise<{ expensesSubmitted: number; expensesApproved: number }> {
    const { data, error } = await orgTable(request, "expenses")
      .select("status")
      .eq("employee_id", employeeId);

    if (error) {
      throw new Error(`Profile: failed to fetch expense stats: ${error.message}`);
    }

    const rows = (data ?? []) as Array<{ status: string }>;
    return {
      expensesSubmitted: rows.length,
      expensesApproved: rows.filter((r) => r.status === "APPROVED").length,
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
};
