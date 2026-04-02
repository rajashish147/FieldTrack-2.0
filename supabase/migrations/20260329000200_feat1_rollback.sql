-- ============================================================
-- feat-1 ROLLBACK — Snapshot Tables
-- ============================================================
-- Run this ONLY to undo migration 20260329000200_feat1_snapshot_tables.sql.
-- This script is destructive: it drops the four snapshot tables and all
-- associated indexes, triggers, policies, and functions.
--
-- Pre-conditions before running:
--   1. Deploy the previous API version (revert the git commit that
--      contains the snapshot.worker.ts and service changes).
--   2. Confirm no live traffic is reading from the snapshot tables.
--   3. Run SELECT COUNT(*) on each table to confirm row counts for audit.
--
-- Post-rollback: the API will return to the original query-time computation
-- paths (employee_daily_metrics aggregation, expenses table full scans).
--
-- ⚠  This script is idempotent (uses IF EXISTS) and is safe to run
--    multiple times.
-- ============================================================

-- ── Drop back-fill function ─────────────────────────────────
DROP FUNCTION IF EXISTS public.backfill_feat1_snapshots();

-- ── Drop triggers ───────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_updated_at_employee_last_state
  ON public.employee_last_state;

DROP TRIGGER IF EXISTS trg_updated_at_employee_metrics_snapshot
  ON public.employee_metrics_snapshot;

-- ── Drop RLS policies ───────────────────────────────────────

-- employee_last_state
DROP POLICY IF EXISTS els2_service_role      ON public.employee_last_state;
DROP POLICY IF EXISTS els2_admin_all         ON public.employee_last_state;
DROP POLICY IF EXISTS els2_employee_self     ON public.employee_last_state;

-- pending_expenses
DROP POLICY IF EXISTS pending_exp_service_role  ON public.pending_expenses;
DROP POLICY IF EXISTS pending_exp_admin_all     ON public.pending_expenses;
DROP POLICY IF EXISTS pending_exp_employee_self ON public.pending_expenses;

-- employee_metrics_snapshot
DROP POLICY IF EXISTS ems_service_role   ON public.employee_metrics_snapshot;
DROP POLICY IF EXISTS ems_admin_all      ON public.employee_metrics_snapshot;
DROP POLICY IF EXISTS ems_employee_self  ON public.employee_metrics_snapshot;

-- active_users
DROP POLICY IF EXISTS active_users_service_role  ON public.active_users;
DROP POLICY IF EXISTS active_users_admin_all     ON public.active_users;
DROP POLICY IF EXISTS active_users_employee_self ON public.active_users;

-- ── Drop indexes ────────────────────────────────────────────
DROP INDEX IF EXISTS public.idx_els_org;
DROP INDEX IF EXISTS public.idx_els_org_checked_in;
DROP INDEX IF EXISTS public.idx_pending_org;
DROP INDEX IF EXISTS public.idx_pending_org_submitted;
DROP INDEX IF EXISTS public.idx_pending_emp;
DROP INDEX IF EXISTS public.idx_metrics_org;
DROP INDEX IF EXISTS public.idx_active_org;

-- ── Drop tables (CASCADE removes dependent triggers/policies)
DROP TABLE IF EXISTS public.active_users              CASCADE;
DROP TABLE IF EXISTS public.pending_expenses          CASCADE;
DROP TABLE IF EXISTS public.employee_metrics_snapshot CASCADE;
DROP TABLE IF EXISTS public.employee_last_state       CASCADE;

-- ============================================================
-- Application rollback (alongside this SQL):
--
--   git revert <commit-sha-of-feat1>
--   # or
--   git checkout <previous-sha> -- src/workers/snapshot.queue.ts
--   git checkout <previous-sha> -- src/workers/snapshot.worker.ts
--   git checkout <previous-sha> -- src/workers/startup.ts
--   git checkout <previous-sha> -- src/modules/attendance/attendance.service.ts
--   git checkout <previous-sha> -- src/modules/locations/locations.service.ts
--   git checkout <previous-sha> -- src/modules/expenses/expenses.service.ts
--   git checkout <previous-sha> -- src/modules/expenses/expenses.controller.ts
--   git checkout <previous-sha> -- src/modules/expenses/expenses.repository.ts
--   git checkout <previous-sha> -- src/modules/employees/employees.repository.ts
--   git checkout <previous-sha> -- src/modules/employees/employees.controller.ts
--   git checkout <previous-sha> -- src/modules/profile/profile.repository.ts
--   git checkout <previous-sha> -- src/modules/profile/profile.service.ts
--
-- The BullMQ "snapshot-engine" queue in Redis will drain naturally.
-- Any jobs still in the queue when workers are stopped can be safely
-- discarded — they only update derived tables, not source tables.
-- ============================================================
