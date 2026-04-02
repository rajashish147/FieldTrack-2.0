/**
 * audit.ts — Lightweight structured audit log writer.
 *
 * Inserts records into `public.admin_audit_log` via the Supabase service
 * client.  Non-fatal: DB insertion failures are logged but never propagate
 * to the caller, so a write error never breaks the primary admin action.
 *
 * Callers should also use `request.log.info({ audit: true, ... })` for
 * structured log correlation in Loki/Grafana alongside DB records.
 */

import { supabaseServiceClient as supabase } from "../config/supabase.js";

export interface AuditEntry {
  event: string;
  actor_id?: string | null;
  organization_id?: string | null;
  resource_type?: string;
  resource_id?: string;
  payload?: Record<string, unknown>;
}

/**
 * Insert one record into `admin_audit_log`.
 *
 * Swallows any DB error and logs it as a warning — audit log failures must
 * never interrupt the primary operation.
 */
export async function insertAuditRecord(entry: AuditEntry): Promise<void> {
  const { error } = await supabase.from("admin_audit_log").insert({
    event:           entry.event,
    actor_id:        entry.actor_id ?? null,
    organization_id: entry.organization_id ?? null,
    resource_type:   entry.resource_type ?? null,
    resource_id:     entry.resource_id ?? null,
    payload:         entry.payload ?? {},
  });

  if (error) {
    // Non-fatal: log but do not throw.
    console.warn("[audit] Failed to persist audit record:", error.message, { event: entry.event });
  }
}
