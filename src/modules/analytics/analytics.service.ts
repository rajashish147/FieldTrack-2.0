import type { FastifyRequest } from "fastify";
import { analyticsRepository } from "./analytics.repository.js";
import { attendanceRepository } from "../attendance/attendance.repository.js";
import { BadRequestError } from "../../utils/errors.js";
import { getCached, ANALYTICS_CACHE_TTL } from "../../utils/cache.js";
import { orgTable } from "../../db/query.js";
import type {
  OrgSummaryData,
  UserSummaryData,
  TopPerformerEntry,
  AnalyticsMetric,
  LeaderboardMetric,
  MinimalExpenseRow,
  SessionTrendEntry,
  LeaderboardEntry,
} from "./analytics.schema.js";

// ─── Internal Aggregation Helpers ─────────────────────────────────────────────

/**
 * Validate that from <= to when both are present.
 * Throws BadRequestError on violation so the controller can return 400.
 */
function validateDateRange(
  from: string | undefined,
  to: string | undefined,
): void {
  if (from !== undefined && to !== undefined) {
    if (new Date(from).getTime() > new Date(to).getTime()) {
      throw new BadRequestError(
        "'from' date must not be later than 'to' date",
      );
    }
  }
}

/**
 * Aggregate expense rows into counts and amounts by status.
 * Pure function — no DB access.
 */
function aggregateExpenses(expenses: MinimalExpenseRow[]): {
  totalExpenses: number;
  approvedExpenseAmount: number;
  rejectedExpenseAmount: number;
} {
  let totalExpenses = 0;
  let approvedExpenseAmount = 0;
  let rejectedExpenseAmount = 0;

  for (const row of expenses) {
    totalExpenses++;
    if (row.status === "APPROVED") approvedExpenseAmount += row.amount;
    if (row.status === "REJECTED") rejectedExpenseAmount += row.amount;
  }

  return {
    totalExpenses,
    approvedExpenseAmount: Math.round(approvedExpenseAmount * 100) / 100,
    rejectedExpenseAmount: Math.round(rejectedExpenseAmount * 100) / 100,
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Analytics service — aggregation logic for all three endpoints.
 *
 * All metric aggregation reads directly from attendance_sessions using
 * the pre-computed total_distance_km / total_duration_seconds columns
 * (populated by the distance worker after each checkout). This avoids
 * an empty session_summaries table returning zero aggregates.
 */
export const analyticsService = {
  /**
   * Org-wide summary for a given date range.
   *
   * Phase 1 optimization: Session stats (count, distance, duration) are now read
   * from org_daily_metrics (pre-aggregated by the analytics worker) instead of
   * scanning attendance_sessions rows directly.  This eliminates the limit(5000)
   * ceiling and makes the query O(days-in-range) instead of O(sessions).
   *
   * Expense stats and active employee count are still fetched in real-time since
   * they are not included in org_daily_metrics.
   */
  async getOrgSummary(
    request: FastifyRequest,
    from: string | undefined,
    to: string | undefined,
  ): Promise<OrgSummaryData> {
    validateDateRange(from, to);

    const cacheKey = `org:${request.organizationId}:analytics:summary:${from ?? "all"}:${to ?? "all"}`;
    return getCached(cacheKey, ANALYTICS_CACHE_TTL, async () => {
      // Step 1: aggregate session stats from pre-computed org_daily_metrics.
      // Date filter uses YYYY-MM-DD format; from/to are full ISO datetimes so
      // we strip to the date portion for the gte/lte comparison.
      const dailyFrom = from ? from.substring(0, 10) : undefined;
      const dailyTo = to ? to.substring(0, 10) : undefined;
      const dailyMetrics = await analyticsRepository.getOrgDailyMetrics(
        request,
        dailyFrom,
        dailyTo,
      );

      let totalSessions = 0;
      let totalDistanceKm = 0;
      let totalDurationSeconds = 0;
      for (const row of dailyMetrics) {
        totalSessions += row.sessions ?? 0;
        totalDistanceKm += row.distance ?? 0;
        totalDurationSeconds += row.duration ?? 0;
      }

      // Step 2: expense aggregation and active employee count — independent, run in parallel
      const [expenseRows, activeEmployeesCount] = await Promise.all([
        analyticsRepository.getExpensesInRange(request, from, to),
        analyticsRepository.getActiveEmployeesCount(request),
      ]);

      const { totalExpenses, approvedExpenseAmount, rejectedExpenseAmount } =
        aggregateExpenses(expenseRows);

      return {
        totalSessions,
        totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
        totalDurationSeconds,
        totalExpenses,
        approvedExpenseAmount,
        rejectedExpenseAmount,
        activeEmployeesCount,
      };
    });
  },

  /**
   * Per-user summary for a given date range.
   *
   * Identity mapping: userIdParam is users.id (JWT sub) — must be resolved to
   * employees.id before querying employee-scoped columns.
   *
   * Process:
   *  1. Resolve users.id → employees.id (one-time lookup)
   *  2. Query sessions/expenses with resolved employees.id
   *  3. Aggregate within the date range
   *
   * Returns empty analytics response if the user has no employee record or no sessions.
   * (Admins may query analytics for users who have no employee profile, were admins,
   * or were deleted — returning 404 would be misleading.)
   */
  async getUserSummary(
    request: FastifyRequest,
    userIdParam: string,
    from: string | undefined,
    to: string | undefined,
  ): Promise<UserSummaryData> {
    validateDateRange(from, to);

    // CRITICAL: Resolve users.id → employees.id (one lookup, reused for all queries)
    const employeeId = await attendanceRepository.findEmployeeIdByUserId(
      request,
      userIdParam,
    );

    if (!employeeId) {
      // User has no employee record (e.g., admin-only user) — return empty analytics
      return {
        sessionsCount: 0,
        totalDistanceKm: 0,
        totalDurationSeconds: 0,
        totalExpenses: 0,
        approvedExpenseAmount: 0,
        averageDistancePerSession: 0,
        averageSessionDurationSeconds: 0,
      };
    }

    // Validate employeeId has sessions in this org — return empty if not
    const userExistsInOrg = await analyticsRepository.checkUserHasSessionsInOrg(
      request,
      employeeId,  // ← Now passing employees.id
    );
    if (!userExistsInOrg) {
      // Employee has no sessions — return empty analytics
      return {
        sessionsCount: 0,
        totalDistanceKm: 0,
        totalDurationSeconds: 0,
        totalExpenses: 0,
        approvedExpenseAmount: 0,
        averageDistancePerSession: 0,
        averageSessionDurationSeconds: 0,
      };
    }

    // Phase 1 optimization: Use employee_daily_metrics (pre-aggregated) instead of
    // scanning attendance_sessions rows. O(days-in-range) vs O(sessions-in-range).
    // Date filter strips ISO timestamps to YYYY-MM-DD for the daily_metrics table.
    const dailyFrom = from ? from.substring(0, 10) : undefined;
    const dailyTo = to ? to.substring(0, 10) : undefined;
    const { totalSessions: sessionsCount, totalDistanceKm, totalDurationSeconds } =
      await analyticsRepository.getEmployeeMetricsForUser(
        request,
        employeeId,
        dailyFrom,
        dailyTo,
      );

    // Expense aggregation for this user in the same date range
    const expenseRows = await analyticsRepository.getExpensesForUser(
      request,
      employeeId,  // ← Now passing employees.id
      from,
      to,
    );

    const { totalExpenses, approvedExpenseAmount } =
      aggregateExpenses(expenseRows);

    const averageDistancePerSession =
      sessionsCount > 0
        ? Math.round((totalDistanceKm / sessionsCount) * 100) / 100
        : 0;

    const averageSessionDurationSeconds =
      sessionsCount > 0
        ? Math.round(totalDurationSeconds / sessionsCount)
        : 0;

    return {
      sessionsCount,
      totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
      totalDurationSeconds,
      totalExpenses,
      approvedExpenseAmount,
      averageDistancePerSession,
      averageSessionDurationSeconds,
    };
  },

  /**
   * Top performers — ranked by distance, duration, or session count.
   *
   * Strategy:
   *  1. Resolve sessions from attendance_sessions in the date range (org-scoped).
   *  2. Group by employee_id in application memory, summing pre-computed metrics.
   *  3. Sort descending by the chosen metric.
   *  4. Slice to limit.
   *
   * Aggregates directly from attendance_sessions.total_distance_km /
   * total_duration_seconds — no GPS data scanned, no join to session_summaries.
   */
  async getTopPerformers(
    request: FastifyRequest,
    metric: AnalyticsMetric,
    from: string | undefined,
    to: string | undefined,
    limit: number,
  ): Promise<TopPerformerEntry[]> {
    validateDateRange(from, to);

    // Single JOIN query — sessions + employee names in one round-trip.
    const sessions = await analyticsRepository.getSessionsWithEmployeeNames(
      request,
      from,
      to,
    );

    // Group by employee_id in a single pass.
    // Employee name is available on each row (from the JOIN), so we capture it
    // the first time we see a given employee_id.
    const employeeMap = new Map<
      string,
      {
        employeeName: string;
        totalDistanceKm: number;
        totalDurationSeconds: number;
        sessionsCount: number;
      }
    >();

    for (const row of sessions) {
      const existing = employeeMap.get(row.employee_id) ?? {
        employeeName: row.employees?.name ?? row.employee_id,
        totalDistanceKm: 0,
        totalDurationSeconds: 0,
        sessionsCount: 0,
      };
      existing.totalDistanceKm += row.total_distance_km ?? 0;
      existing.totalDurationSeconds += row.total_duration_seconds ?? 0;
      existing.sessionsCount += 1;
      employeeMap.set(row.employee_id, existing);
    }

    // Convert to array and sort descending by the chosen metric
    const entries = [...employeeMap.entries()];

    if (metric === "distance") {
      entries.sort(
        (a, b) => b[1].totalDistanceKm - a[1].totalDistanceKm,
      );
    } else if (metric === "duration") {
      entries.sort(
        (a, b) => b[1].totalDurationSeconds - a[1].totalDurationSeconds,
      );
    } else {
      // metric === "sessions"
      entries.sort((a, b) => b[1].sessionsCount - a[1].sessionsCount);
    }

    // Shape the response — names are already in the map, no second query needed
    return entries.slice(0, limit).map(([employeeId, stats]) => {
      if (metric === "distance") {
        return {
          employeeId,
          employeeName: stats.employeeName,
          totalDistanceKm: Math.round(stats.totalDistanceKm * 100) / 100,
        };
      }
      if (metric === "duration") {
        return {
          employeeId,
          employeeName: stats.employeeName,
          totalDurationSeconds: stats.totalDurationSeconds,
        };
      }
      // metric === "sessions"
      return {
        employeeId,
        employeeName: stats.employeeName,
        sessionsCount: stats.sessionsCount,
      };
    });
  },

  /**
   * Session trend — daily time-series from org_daily_metrics.
   * Cached for 5 minutes per org + date range combination.
   */
  async getSessionTrend(
    request: FastifyRequest,
    from: string | undefined,
    to: string | undefined,
  ): Promise<SessionTrendEntry[]> {
    validateDateRange(from, to);
    const cacheKey = `org:${request.organizationId}:analytics:trend:${from ?? "all"}:${to ?? "all"}`;
    return getCached(cacheKey, ANALYTICS_CACHE_TTL, () =>
      analyticsRepository.getOrgDailyMetrics(request, from, to),
    );
  },

  /**
   * Leaderboard — ranked employees from employee_daily_metrics.
   * Returns rank, employee info, and all metric values.
   *
   * Supports metrics: distance | duration | sessions | expenses.
   * For the "expenses" metric, ranks employees by number of expense submissions
   * in the date range rather than session-derived metrics.
   *
   * All results are cached for 5 minutes per org + metric + limit + date range.
   */
  async getLeaderboard(
    request: FastifyRequest,
    metric: LeaderboardMetric,
    from: string | undefined,
    to: string | undefined,
    limit: number,
  ): Promise<LeaderboardEntry[]> {
    validateDateRange(from, to);

    const cacheKey = `org:${request.organizationId}:analytics:leaderboard:${metric}:${limit}:${from ?? "all"}:${to ?? "all"}`;
    return getCached(cacheKey, ANALYTICS_CACHE_TTL, async () => {
      // All metrics — distance / duration / sessions / expenses — read from
      // employee_daily_metrics so no GPS or expenses table scans are needed.
      const aggregated = await analyticsRepository.getEmployeeMetricsAggregated(
        request,
        from,
        to,
      );

      if (aggregated.length === 0) return [];

      // Sort by the chosen metric descending.
      // employee_id is used as a stable secondary key so that ties produce a
      // consistent ranking across calls (deterministic, no flickering UI).
      if (metric === "distance") {
        aggregated.sort(
          (a, b) =>
            b.total_distance - a.total_distance ||
            a.employee_id.localeCompare(b.employee_id),
        );
      } else if (metric === "duration") {
        aggregated.sort(
          (a, b) =>
            b.total_duration - a.total_duration ||
            a.employee_id.localeCompare(b.employee_id),
        );
      } else if (metric === "sessions") {
        aggregated.sort(
          (a, b) =>
            b.total_sessions - a.total_sessions ||
            a.employee_id.localeCompare(b.employee_id),
        );
      } else {
        // metric === "expenses" — ORDER BY SUM(expenses_amount) DESC
        aggregated.sort(
          (a, b) =>
            b.total_expenses_amount - a.total_expenses_amount ||
            a.employee_id.localeCompare(b.employee_id),
        );
      }

      const topN = aggregated.slice(0, limit);
      const employeeIds = topN.map((a) => a.employee_id);

      // Resolve employee names and codes in a single query
      const { data: employees } = await orgTable(request, "employees")
        .select("id, name, employee_code")
        .in("id", employeeIds);

      const empMap = new Map<string, { name: string; employee_code: string | null }>();
      for (const emp of (employees ?? []) as Array<Record<string, unknown>>) {
        empMap.set(emp.id as string, {
          name: (emp.name as string) ?? "Unknown",
          employee_code: (emp.employee_code as string) ?? null,
        });
      }

      return topN.map((entry, idx) => {
        const empInfo = empMap.get(entry.employee_id);
        return {
          rank: idx + 1,
          employeeId: entry.employee_id,
          employeeCode: empInfo?.employee_code ?? null,
          employeeName: empInfo?.name ?? entry.employee_id,
          distance: Math.round(entry.total_distance * 100) / 100,
          sessions: entry.total_sessions,
          duration: entry.total_duration,
          // expenses field populated for all entries; only the "expenses" sort
          // makes it primary. Omit when zero to keep response lean.
          ...(entry.total_expenses_amount > 0 || metric === "expenses"
            ? { expenses: Math.round(entry.total_expenses_amount * 100) / 100 }
            : {}),
        };
      });
    });
  },
};
