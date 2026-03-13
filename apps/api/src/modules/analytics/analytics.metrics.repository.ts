import { supabaseServiceClient as supabase } from "../../config/supabase.js";

/**
 * Write-side analytics repository — UPSERT operations for daily metrics tables.
 *
 * Uses supabaseServiceClient directly (service role, bypasses RLS) so it can
 * be called from both HTTP request handlers and background workers without a
 * FastifyRequest.
 *
 * Tenant isolation is enforced explicitly via organization_id in every query.
 *
 * UPSERT strategy: read current row → compute new totals → upsert.
 * Supabase's .upsert() with onConflict generates:
 *   INSERT INTO ... ON CONFLICT (key) DO UPDATE SET col = EXCLUDED.col
 * Only the columns included in the upsert payload appear in the SET clause,
 * so partial upserts (e.g. session-only or expense-only) safely leave the
 * other columns at their existing DB values on conflict.
 *
 * Race condition note: the read-then-upsert window is milliseconds. For daily
 * aggregates driven by checkout and expense events, concurrent writes to the
 * same (employee_id, date) row are extremely rare. True atomic increments
 * would require a Postgres function (deferred to a future migration).
 */
export const analyticsMetricsRepository = {
  /**
   * UPSERT employee_daily_metrics — session columns only.
   * Called by the distance worker after session distance/duration is computed.
   * Increments sessions by 1 and adds the computed distance and duration.
   * Leaves expenses_count and expenses_amount at their current values.
   */
  async upsertEmployeeDailySessionMetrics(params: {
    organizationId: string;
    employeeId: string;
    /** ISO date string YYYY-MM-DD derived from session checkin_at */
    date: string;
    distanceDeltaKm: number;
    durationDeltaSeconds: number;
  }): Promise<void> {
    const { organizationId, employeeId, date, distanceDeltaKm, durationDeltaSeconds } = params;

    // Read current totals so we can compute the new incremented row
    const { data: current } = await supabase
      .from("employee_daily_metrics")
      .select("sessions, distance_km, duration_seconds")
      .eq("organization_id", organizationId)
      .eq("employee_id", employeeId)
      .eq("date", date)
      .maybeSingle();

    const row = (current ?? {}) as Record<string, number>;

    const { error } = await supabase
      .from("employee_daily_metrics")
      .upsert(
        {
          organization_id: organizationId,
          employee_id: employeeId,
          date,
          sessions: (row["sessions"] ?? 0) + 1,
          distance_km:
            Math.round(((row["distance_km"] ?? 0) + distanceDeltaKm) * 1000) / 1000,
          duration_seconds:
            (row["duration_seconds"] ?? 0) + durationDeltaSeconds,
        },
        // Conflict target must match the DB unique constraint on the table.
        // Task spec: unique key is (employee_id, date).
        { onConflict: "employee_id,date" },
      );

    if (error) {
      throw new Error(
        `Analytics: failed to upsert employee session metrics: ${error.message}`,
      );
    }
  },

  /**
   * UPSERT org_daily_metrics — session columns only.
   * Called alongside upsertEmployeeDailySessionMetrics after session completion.
   * Increments total_sessions by 1 and adds distance and duration.
   */
  async upsertOrgDailySessionMetrics(params: {
    organizationId: string;
    /** ISO date string YYYY-MM-DD */
    date: string;
    distanceDeltaKm: number;
    durationDeltaSeconds: number;
  }): Promise<void> {
    const { organizationId, date, distanceDeltaKm, durationDeltaSeconds } = params;

    const { data: current } = await supabase
      .from("org_daily_metrics")
      .select("total_sessions, total_distance_km, total_duration_seconds")
      .eq("organization_id", organizationId)
      .eq("date", date)
      .maybeSingle();

    const row = (current ?? {}) as Record<string, number>;

    const { error } = await supabase
      .from("org_daily_metrics")
      .upsert(
        {
          organization_id: organizationId,
          date,
          total_sessions: (row["total_sessions"] ?? 0) + 1,
          total_distance_km:
            Math.round(
              ((row["total_distance_km"] ?? 0) + distanceDeltaKm) * 1000,
            ) / 1000,
          total_duration_seconds:
            (row["total_duration_seconds"] ?? 0) + durationDeltaSeconds,
        },
        { onConflict: "organization_id,date" },
      );

    if (error) {
      throw new Error(
        `Analytics: failed to upsert org session metrics: ${error.message}`,
      );
    }
  },

  /**
   * UPSERT employee_daily_metrics — expense columns only.
   * Called after a new expense is created.
   * Increments expenses_count by 1 and adds the expense amount.
   * Leaves sessions, distance_km, and duration_seconds at their current values.
   */
  async upsertEmployeeDailyExpenseMetrics(params: {
    organizationId: string;
    employeeId: string;
    /** ISO date string YYYY-MM-DD derived from the current moment */
    date: string;
    amountDelta: number;
  }): Promise<void> {
    const { organizationId, employeeId, date, amountDelta } = params;

    const { data: current } = await supabase
      .from("employee_daily_metrics")
      .select("expenses_count, expenses_amount")
      .eq("organization_id", organizationId)
      .eq("employee_id", employeeId)
      .eq("date", date)
      .maybeSingle();

    const row = (current ?? {}) as Record<string, number>;

    const { error } = await supabase
      .from("employee_daily_metrics")
      .upsert(
        {
          organization_id: organizationId,
          employee_id: employeeId,
          date,
          expenses_count: (row["expenses_count"] ?? 0) + 1,
          expenses_amount:
            Math.round(
              ((row["expenses_amount"] ?? 0) + amountDelta) * 100,
            ) / 100,
        },
        { onConflict: "employee_id,date" },
      );

    if (error) {
      throw new Error(
        `Analytics: failed to upsert employee expense metrics: ${error.message}`,
      );
    }
  },
};
