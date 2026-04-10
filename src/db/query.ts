import type { FastifyRequest } from "fastify";
import type { TenantContext } from "../utils/tenant.js";
import { supabaseServiceClient } from "../config/supabase.js";
import type { Database } from "../types/database.js";

/**
 * Tenant-aware query factory for backend database access.
 *
 * Returns an object whose select/update/delete methods are pre-scoped to the
 * requesting organization. The tenant filter is applied at construction time,
 * making it structurally impossible to omit.
 *
 * Use for SELECT, UPDATE, and DELETE in repository files.
 * INSERT and UPSERT operations set organization_id explicitly in the payload
 * and call supabaseServiceClient.from() directly.
 *
 * Usage:
 *   const { data, error } = await orgTable(request, "expenses")
 *     .select("id, amount, status")
 *     .eq("employee_id", employeeId)
 *     .order("submitted_at", { ascending: false });
 *
 * Phase 4: OrgScopedTable is now derived directly from the Database type so
 * every new table in database.ts automatically becomes available here.
 */

/** All org-scoped tables that carry an organization_id column. */
export type OrgScopedTable = Extract<
  keyof Database["public"]["Tables"],
  | "active_users"
  | "admin_sessions"
  | "attendance_sessions"
  | "employees"
  | "employee_daily_metrics"
  | "employee_last_state"
  | "employee_latest_sessions"
  | "employee_metrics_snapshot"
  | "expenses"
  | "gps_locations"
  | "org_daily_metrics"
  | "org_dashboard_snapshot"
  | "pending_expenses"
  | "session_summaries"
  | "webhook_deliveries"
  | "webhook_events"
  | "webhooks"
>;

export function orgTable(
    context: TenantContext | FastifyRequest,
    table: OrgScopedTable,
) {
    const orgId = context.organizationId;

    if (!orgId) {
        throw new Error("Tenant enforcement failed: organizationId missing");
    }

    // supabaseServiceClient is untyped (no Database generic), so Supabase's
    // column-string parser emits GenericStringError when the table name is a
    // runtime string rather than a literal. Casting through `any` restores the
    // same `any`-result typing that direct .from("literal") calls had before,
    // and repository methods cast data to their own types regardless.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseServiceClient as any;

    return {
        select(columns = "*", options?: { count?: "exact" | "planned" | "estimated"; head?: boolean }) {
            return db.from(table).select(columns, options).eq("organization_id", orgId);
        },
        update<V extends Partial<Database["public"]["Tables"][OrgScopedTable]["Update"]>>(values: V) {
            return db.from(table).update(values).eq("organization_id", orgId);
        },
        delete() {
            return db.from(table).delete().eq("organization_id", orgId);
        },
    };
}
