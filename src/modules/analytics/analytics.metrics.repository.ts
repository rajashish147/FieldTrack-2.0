import { supabaseServiceClient as supabase } from "../../config/supabase.js";

/**
 * Write-side analytics repository — atomic increment operations for daily metrics tables.
 *
 * Uses supabaseServiceClient directly (service role, bypasses RLS) so it can
 * be called from both HTTP request handlers and background workers without a
 * FastifyRequest.
 *
 * Tenant isolation is enforced explicitly via organization_id in every query.
 *
 * Each function delegates to a SECURITY DEFINER PostgreSQL function that performs
 * a single atomic INSERT ... ON CONFLICT DO UPDATE with DB-side arithmetic.
 * This eliminates the TOCTOU race condition that existed in the previous
 * read-then-upsert pattern under concurrent checkouts for the same (employee_id, date).
 */
export const analyticsMetricsRepository = {
  /**
   * Atomically increment employee session metrics.
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

    const { error } = await supabase.rpc("increment_employee_session_metrics", {
      p_organization_id: organizationId,
      p_employee_id: employeeId,
      p_date: date,
      p_distance_km: distanceDeltaKm,
      p_duration_seconds: durationDeltaSeconds,
    });

    if (error) {
      throw new Error(
        `Analytics: failed to upsert employee session metrics: ${error.message}`,
      );
    }
  },

  /**
   * Atomically increment org session metrics.
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

    const { error } = await supabase.rpc("increment_org_session_metrics", {
      p_organization_id: organizationId,
      p_date: date,
      p_distance_km: distanceDeltaKm,
      p_duration_seconds: durationDeltaSeconds,
    });

    if (error) {
      throw new Error(
        `Analytics: failed to upsert org session metrics: ${error.message}`,
      );
    }
  },

  /**
   * Atomically increment employee expense metrics.
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

    const { error } = await supabase.rpc("increment_employee_expense_metrics", {
      p_organization_id: organizationId,
      p_employee_id: employeeId,
      p_date: date,
      p_amount: amountDelta,
    });

    if (error) {
      throw new Error(
        `Analytics: failed to upsert employee expense metrics: ${error.message}`,
      );
    }
  },
};

