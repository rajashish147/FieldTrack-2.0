/**
 * reconciliation.job.ts — Periodic snapshot-table self-healing job.
 *
 * Calls the `reconcile_snapshot_tables()` Postgres function every 5 minutes.
 * The function runs idempotent UPSERTs that rebuild five denormalised tables
 * from their authoritative source tables:
 *
 *   employee_last_state       ← attendance_sessions (latest per employee)
 *   active_users              ← attendance_sessions (checkout_at IS NULL)
 *   employee_latest_sessions  ← attendance_sessions (latest per employee + status)
 *   employee_metrics_snapshot ← employee_daily_metrics + approved expenses
 *   org_dashboard_snapshot    ← employee_latest_sessions + org_daily_metrics + pending expenses
 *
 * This "self-healing" guard means that if Redis goes down and BullMQ workers
 * stall, the snapshot tables recover automatically within ≤5 minutes once
 * Redis is restored and the job fires its next interval.
 *
 * The job DOES NOT block startup and DOES NOT count toward WORKER_TYPES
 * (it is a scheduled job, not a BullMQ Worker).
 */

import type { FastifyInstance } from "fastify";
import { supabaseServiceClient as supabase } from "../config/supabase.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Job ─────────────────────────────────────────────────────────────────────

export function startReconciliationJob(app: FastifyInstance): void {
  const run = async (): Promise<void> => {
    const t0 = Date.now();
    try {
      const { data, error } = await supabase.rpc("reconcile_snapshot_tables");
      if (error) {
        app.log.error(
          { error: error.message },
          "reconciliation-job: reconcile_snapshot_tables() failed",
        );
        return;
      }
      app.log.info(
        { durationMs: Date.now() - t0, rows: data },
        "reconciliation-job: snapshot tables reconciled",
      );
    } catch (err: unknown) {
      app.log.error(
        { error: String(err) },
        "reconciliation-job: unexpected error during reconciliation",
      );
    }
  };

  // Fire immediately on startup so stale data is repaired at boot time,
  // then repeat on the interval.
  void run();

  const timer = setInterval(() => {
    void run();
  }, RECONCILE_INTERVAL_MS);

  // Unref so the timer never prevents graceful shutdown.
  timer.unref();

  app.log.info(
    { intervalMs: RECONCILE_INTERVAL_MS },
    "reconciliation-job: started (every 5 minutes)",
  );
}
