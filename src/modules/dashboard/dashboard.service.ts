import type { FastifyRequest } from "fastify";
import { orgTable } from "../../db/query.js";
import type { DashboardSummary } from "../../types/shared.js";

/**
 * Returns the ISO date string for the Monday of the current UTC week (YYYY-MM-DD).
 * Used as the lower bound for employee_daily_metrics range queries.
 */
function getWeekStartDate(): string {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0 = Sun, 1 = Mon … 6 = Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7; // Mon = 0, Tue = 1 …
  const weekStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday),
  );
  return weekStart.toISOString().substring(0, 10); // YYYY-MM-DD
}

export const dashboardService = {
  /**
   * GET /dashboard/my-summary
   *
   * Returns statistics for the current employee scoped to the current ISO week
   * (Mon 00:00 UTC → now) plus all-time expense counts.
   *
   * Phase 1 optimization: Replaced raw attendance_sessions scan with
   * employee_daily_metrics (pre-aggregated by the analytics worker). This avoids
   * full-table scans on high-volume session tables — one bounded date-range lookup
   * against the metrics table instead of potentially thousands of session rows.
   *
   * Returns all zeros for ADMIN users who have no employee record.
   */
  async getMySummary(request: FastifyRequest): Promise<DashboardSummary> {
    const employeeId = request.employeeId;

    if (!employeeId) {
      return {
        sessionsThisWeek: 0,
        distanceThisWeek: 0,
        hoursThisWeek: 0,
        expensesSubmitted: 0,
        expensesApproved: 0,
      };
    }

    const weekStartDate = getWeekStartDate(); // YYYY-MM-DD, aligns with daily_metrics.date

    // employee_daily_metrics aggregates session and expense data per day.
    // Querying this week's rows (Mon → today) is O(~5-7 rows) not O(sessions).
    // expenses_count / expenses_amount track submissions; we still need status
    // breakdown so we keep a bounded expense query (only this week's submissions).
    // Three queries run in parallel:
    //   1. This week's daily metrics rows (bounded by date range — at most ~7 rows)
    //   2. Total expense count via HEAD (no rows fetched, pure COUNT(*))
    //   3. Approved expense count via HEAD (no rows fetched, pure COUNT(*))
    //
    // Previously a single SELECT status FROM expenses with no LIMIT was used.
    // For a long-tenured employee with hundreds of expenses that caused an
    // unbounded row fetch on every dashboard load.  COUNT HEAD queries are O(1)
    // index scans and eliminate the payload entirely.
    const [metricsResult, submittedResult, approvedResult] = await Promise.all([
      orgTable(request, "employee_daily_metrics")
        .select("sessions, distance_km, duration_seconds")
        .eq("employee_id", employeeId)
        .gte("date", weekStartDate),
      orgTable(request, "expenses")
        .select("id", { count: "exact", head: true })
        .eq("employee_id", employeeId),
      orgTable(request, "expenses")
        .select("id", { count: "exact", head: true })
        .eq("employee_id", employeeId)
        .eq("status", "APPROVED"),
    ]);

    if (metricsResult.error) {
      throw new Error(`Dashboard metrics query failed: ${metricsResult.error.message}`);
    }
    if (submittedResult.error) {
      throw new Error(`Dashboard expenses submitted count failed: ${submittedResult.error.message}`);
    }
    if (approvedResult.error) {
      throw new Error(`Dashboard expenses approved count failed: ${approvedResult.error.message}`);
    }

    const metricRows = (metricsResult.data ?? []) as {
      sessions: number;
      distance_km: number;
      duration_seconds: number;
    }[];

    let sessionsThisWeek = 0;
    let distanceThisWeek = 0;
    let durationSecondsThisWeek = 0;

    for (const row of metricRows) {
      sessionsThisWeek += row.sessions ?? 0;
      distanceThisWeek += row.distance_km ?? 0;
      durationSecondsThisWeek += row.duration_seconds ?? 0;
    }

    return {
      sessionsThisWeek,
      distanceThisWeek: Math.round(distanceThisWeek * 100) / 100,
      hoursThisWeek: Math.round((durationSecondsThisWeek / 3600) * 100) / 100,
      expensesSubmitted: submittedResult.count ?? 0,
      expensesApproved: approvedResult.count ?? 0,
    };
  },
};
