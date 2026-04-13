import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import { orgTable } from "../../db/query.js";
import { applyPagination } from "../../utils/pagination.js";
import type { FastifyRequest } from "fastify";
import type { AdminSession } from "../../types/db.js";
import { BadRequestError } from "../../utils/errors.js";

const MONITORING_COLS = "id, admin_id, organization_id, started_at, ended_at, created_at";

export const monitoringRepository = {
  /**
   * Get the active monitoring session for the admin, if any.
   */
  async getActiveSession(request: FastifyRequest): Promise<AdminSession | null> {
    const { data, error } = await orgTable(request, "admin_sessions")
      .select(MONITORING_COLS)
      .eq("admin_id", request.user.sub)
      .is("ended_at", null)
      .single();

    if (error) {
      // PGRST116 means no rows found, which is expected
      if (error.code === "PGRST116") {
        return null;
      }
      throw new Error(`Failed to get active session: ${error.message}`);
    }

    return data as AdminSession;
  },

  /**
   * Insert a new admin monitoring session with ended_at = null.
   */
  async startSession(request: FastifyRequest): Promise<AdminSession> {
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("admin_sessions")
      .insert({
        admin_id: request.user.sub,
        organization_id: request.organizationId,
        started_at: now,
      })
      .select(MONITORING_COLS)
      .single();

    if (error) {
      // Unique constraint "one_active_monitoring_session" fires when the admin
      // already has an open session (ended_at IS NULL).
      if (error.code === "23505") {
        throw new BadRequestError("A monitoring session is already active. Stop it before starting a new one.");
      }
      throw new Error(`Failed to start monitoring session: ${error.message}`);
    }
    return data as AdminSession;
  },

  /**
   * Close the most recent open monitoring session for this admin.
   * Returns null (mapped to NotFoundError by the service) if none is open.
   * Handles the edge case of multiple open sessions gracefully by closing
   * all of them and returning the most recently started one.
   */
  async stopSession(request: FastifyRequest): Promise<AdminSession | null> {
    const now = new Date().toISOString();

    const { data, error } = await orgTable(request, "admin_sessions")
      .update({ ended_at: now })
      .eq("admin_id", request.user.sub)
      .is("ended_at", null)
      .select(MONITORING_COLS);

    if (error) {
      throw new Error(`Failed to stop monitoring session: ${error.message}`);
    }

    const sessions = (data ?? []) as AdminSession[];

    if (sessions.length === 0) return null;

    // Return the most recent session (handles >1 open sessions gracefully)
    return sessions.sort(
      (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
    )[0];
  },

  /**
   * Return monitoring history for the authenticated admin, newest first.
   */
  async findHistory(
    request: FastifyRequest,
    page: number,
    limit: number,
  ): Promise<{ data: AdminSession[]; total: number }> {
    // When auth is via API key, request.user.sub is "api_key:<id>" — not a real
    // users.id UUID. Filtering by admin_id would cause a DB type error. Instead,
    // return all org sessions (API key callers have org-level access, not user-level).
    let baseQuery = orgTable(request, "admin_sessions")
      .select(MONITORING_COLS, { count: "exact" })
      .order("started_at", { ascending: false });
    if (request.authType !== "api_key") {
      baseQuery = baseQuery.eq("admin_id", request.user.sub);
    }
    const { data, error, count } = await applyPagination(baseQuery, page, limit);

    if (error) {
      throw new Error(`Failed to fetch monitoring history: ${error.message}`);
    }
    return { data: (data ?? []) as AdminSession[], total: count ?? 0 };
  },
};
