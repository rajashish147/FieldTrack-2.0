import { supabase } from "../../config/supabase.js";
import { enforceTenant } from "../../utils/tenant.js";
import type { FastifyRequest } from "fastify";
import type {
  MinimalSessionRow,
  MinimalSummaryRow,
  MinimalExpenseRow,
} from "./analytics.schema.js";

/**
 * Analytics repository — read-only queries for the analytics layer.
 *
 * Design principles:
 *  - Never select("*") — only fetch columns required for aggregation.
 *  - All queries are scoped via enforceTenant() — cross-tenant reads are impossible.
 *  - Two-query pattern for session range filtering:
 *      1. Resolve session IDs from attendance_sessions (date + org scoped).
 *      2. Fetch session_summaries for those IDs (org double-checked via enforceTenant).
 *    This avoids raw SQL joins while keeping a single-round-trip aggregation.
 *  - Early-return empty arrays when the first query returns no rows to avoid
 *    sending large IN lists and unnecessary round trips.
 *  - All index assumptions documented inline.
 *
 * Index dependencies:
 *   attendance_sessions(organization_id, check_in_at)        — range scan
 *   session_summaries(session_id, organization_id)           — IN lookup
 *   expenses(organization_id, created_at)                    — range scan
 */
export const analyticsRepository = {
  // ─── Session Helpers ──────────────────────────────────────────────────────

  /**
   * Resolve sessions within an optional date range for the requesting org.
   * Returns minimal {id, user_id} rows — no GPS data, no full row fetches.
   *
   * Relies on index: attendance_sessions(organization_id, check_in_at)
   */
  async getSessionsInRange(
    request: FastifyRequest,
    from: string | undefined,
    to: string | undefined,
  ): Promise<MinimalSessionRow[]> {
    let baseQuery = supabase
      .from("attendance_sessions")
      .select("id, user_id")
      .order("check_in_at", { ascending: false });

    if (from !== undefined) {
      baseQuery = baseQuery.gte("check_in_at", from) as typeof baseQuery;
    }
    if (to !== undefined) {
      baseQuery = baseQuery.lte("check_in_at", to) as typeof baseQuery;
    }

    const { data, error } = await enforceTenant(request, baseQuery);

    if (error) {
      throw new Error(`Analytics: failed to fetch sessions in range: ${error.message}`);
    }
    return (data ?? []) as MinimalSessionRow[];
  },

  /**
   * Resolve sessions within an optional date range filtered to a specific user.
   * Used by user-summary to build the session ID list before hitting session_summaries.
   */
  async getSessionsForUser(
    request: FastifyRequest,
    userId: string,
    from: string | undefined,
    to: string | undefined,
  ): Promise<MinimalSessionRow[]> {
    let baseQuery = supabase
      .from("attendance_sessions")
      .select("id, user_id")
      .eq("user_id", userId)
      .order("check_in_at", { ascending: false });

    if (from !== undefined) {
      baseQuery = baseQuery.gte("check_in_at", from) as typeof baseQuery;
    }
    if (to !== undefined) {
      baseQuery = baseQuery.lte("check_in_at", to) as typeof baseQuery;
    }

    const { data, error } = await enforceTenant(request, baseQuery);

    if (error) {
      throw new Error(`Analytics: failed to fetch user sessions: ${error.message}`);
    }
    return (data ?? []) as MinimalSessionRow[];
  },

  /**
   * Lightweight check — returns true if the user has at least one attendance
   * session in the requesting org. Used to validate userId before running
   * a full user-summary aggregation.
   *
   * Returns false (not an error) if the user is unknown in this org so the
   * service layer can throw a domain-level NotFoundError with a clear message.
   */
  async checkUserHasSessionsInOrg(
    request: FastifyRequest,
    userId: string,
  ): Promise<boolean> {
    const baseQuery = supabase
      .from("attendance_sessions")
      .select("id")
      .eq("user_id", userId)
      .limit(1);

    const { data, error } = await enforceTenant(request, baseQuery);

    if (error) {
      throw new Error(`Analytics: user validation query failed: ${error.message}`);
    }
    return (data ?? []).length > 0;
  },

  // ─── Summary Helpers ──────────────────────────────────────────────────────

  /**
   * Fetch pre-computed session summary rows for a given list of session IDs.
   * session_summaries contains one row per closed session — reading from here
   * avoids scanning the raw locations table (which can hold 30k rows per session).
   *
   * enforceTenant() provides defense-in-depth: even though sessionIds were
   * resolved from an org-scoped query, an explicit organization_id filter
   * ensures cross-tenant reads are impossible at the DB layer.
   *
   * Relies on index: session_summaries(session_id, organization_id)
   */
  async getSummariesForSessions(
    request: FastifyRequest,
    sessionIds: string[],
  ): Promise<MinimalSummaryRow[]> {
    if (sessionIds.length === 0) return [];

    const baseQuery = supabase
      .from("session_summaries")
      .select("user_id, total_distance_meters, duration_seconds")
      .in("session_id", sessionIds);

    const { data, error } = await enforceTenant(request, baseQuery);

    if (error) {
      throw new Error(`Analytics: failed to fetch session summaries: ${error.message}`);
    }
    return (data ?? []) as MinimalSummaryRow[];
  },

  // ─── Expense Helpers ──────────────────────────────────────────────────────

  /**
   * Fetch minimal expense rows (amount + status only) for the org within the
   * optional date range. Aggregation happens in the service layer.
   *
   * Relies on index: expenses(organization_id, created_at)
   */
  async getExpensesInRange(
    request: FastifyRequest,
    from: string | undefined,
    to: string | undefined,
  ): Promise<MinimalExpenseRow[]> {
    let baseQuery = supabase
      .from("expenses")
      .select("amount, status");

    if (from !== undefined) {
      baseQuery = baseQuery.gte("created_at", from) as typeof baseQuery;
    }
    if (to !== undefined) {
      baseQuery = baseQuery.lte("created_at", to) as typeof baseQuery;
    }

    const { data, error } = await enforceTenant(request, baseQuery);

    if (error) {
      throw new Error(`Analytics: failed to fetch expenses: ${error.message}`);
    }
    return (data ?? []) as MinimalExpenseRow[];
  },

  /**
   * Same as getExpensesInRange but scoped to a specific user_id.
   */
  async getExpensesForUser(
    request: FastifyRequest,
    userId: string,
    from: string | undefined,
    to: string | undefined,
  ): Promise<MinimalExpenseRow[]> {
    let baseQuery = supabase
      .from("expenses")
      .select("amount, status")
      .eq("user_id", userId);

    if (from !== undefined) {
      baseQuery = baseQuery.gte("created_at", from) as typeof baseQuery;
    }
    if (to !== undefined) {
      baseQuery = baseQuery.lte("created_at", to) as typeof baseQuery;
    }

    const { data, error } = await enforceTenant(request, baseQuery);

    if (error) {
      throw new Error(`Analytics: failed to fetch user expenses: ${error.message}`);
    }
    return (data ?? []) as MinimalExpenseRow[];
  },
};
