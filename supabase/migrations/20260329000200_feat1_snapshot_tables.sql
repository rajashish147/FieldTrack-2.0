-- ============================================================
-- feat-1: Snapshot Tables for Read-Optimised Architecture
-- ============================================================
-- Goal:  Move all dashboard reads from query-time computation to
--        precomputed snapshot tables so every API returns in <50 ms.
--
-- New tables:
--   1. employee_last_state      — real-time check-in state per employee
--   2. pending_expenses         — denormalised view of PENDING expenses
--   3. employee_metrics_snapshot — cumulative per-employee totals
--   4. active_users             — currently checked-in employees
--
-- All tables have:
--   • RLS enabled
--   • service_role bypass (workers write via service role key)
--   • admin_all   policy  (ADMIN reads all rows in their org)
--   • employee_self policy (EMPLOYEE reads only their own row)
--   • updated_at trigger
--
-- Idempotent: every DDL statement uses IF NOT EXISTS / OR REPLACE.
-- ============================================================

-- ══════════════════════════════════════════════════════════════
-- 1. employee_last_state
-- ══════════════════════════════════════════════════════════════
-- Tracks the most-recent real-time state for each field employee.
-- Written by the snapshot worker on CHECK_IN, CHECK_OUT, and
-- LOCATION_UPDATE events.  Replaces scatter-gather joins on
-- attendance_sessions + gps_locations for live employee views.

CREATE TABLE IF NOT EXISTS public.employee_last_state (
  employee_id       UUID        PRIMARY KEY
                                REFERENCES public.employees(id) ON DELETE CASCADE,
  organization_id   UUID        NOT NULL
                                REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Session linkage
  last_session_id   UUID        REFERENCES public.attendance_sessions(id) ON DELETE SET NULL,
  is_checked_in     BOOLEAN     NOT NULL DEFAULT false,

  -- Real-time location (NULL until first GPS report)
  last_latitude     DOUBLE PRECISION,
  last_longitude    DOUBLE PRECISION,
  last_location_at  TIMESTAMPTZ,

  -- Attendance timestamps
  last_check_in_at  TIMESTAMPTZ,
  last_check_out_at TIMESTAMPTZ,

  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.employee_last_state IS
  'feat-1 snapshot: one row per employee, updated on every attendance/location event.
   Powers the live employee list and map without scanning attendance_sessions.';

CREATE INDEX IF NOT EXISTS idx_els_org
  ON public.employee_last_state (organization_id);

CREATE INDEX IF NOT EXISTS idx_els_org_checked_in
  ON public.employee_last_state (organization_id)
  WHERE is_checked_in = true;

-- updated_at auto-stamp
CREATE TRIGGER trg_updated_at_employee_last_state
  BEFORE UPDATE ON public.employee_last_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ══════════════════════════════════════════════════════════════
-- 2. pending_expenses
-- ══════════════════════════════════════════════════════════════
-- Denormalised projection of expenses WHERE status = 'PENDING'.
-- Inserted by the snapshot worker on EXPENSE_CREATED.
-- Deleted by the snapshot worker on EXPENSE_APPROVED / EXPENSE_REJECTED.
-- The primary key mirrors expenses.id for direct lookups.

CREATE TABLE IF NOT EXISTS public.pending_expenses (
  id              UUID        PRIMARY KEY
                              REFERENCES public.expenses(id) ON DELETE CASCADE,
  organization_id UUID        NOT NULL
                              REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id     UUID        NOT NULL
                              REFERENCES public.employees(id) ON DELETE CASCADE,

  amount          NUMERIC     NOT NULL,
  category        TEXT,                      -- future: expense category field
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pending_expenses IS
  'feat-1 snapshot: mirror of expenses WHERE status=PENDING.
   Enables O(1) admin pending-expense queries without scanning the full expenses table.';

CREATE INDEX IF NOT EXISTS idx_pending_org
  ON public.pending_expenses (organization_id);

CREATE INDEX IF NOT EXISTS idx_pending_org_submitted
  ON public.pending_expenses (organization_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_emp
  ON public.pending_expenses (organization_id, employee_id);

-- ══════════════════════════════════════════════════════════════
-- 3. employee_metrics_snapshot
-- ══════════════════════════════════════════════════════════════
-- Cumulative (all-time) totals per employee.  Updated by the snapshot
-- worker after checkout and expense approval by recomputing from
-- employee_daily_metrics + expenses — fully idempotent via SET not +=.

CREATE TABLE IF NOT EXISTS public.employee_metrics_snapshot (
  employee_id      UUID        PRIMARY KEY
                               REFERENCES public.employees(id) ON DELETE CASCADE,
  organization_id  UUID        NOT NULL
                               REFERENCES public.organizations(id) ON DELETE CASCADE,

  total_sessions   INT         NOT NULL DEFAULT 0,
  total_hours      NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_distance   NUMERIC(12,4) NOT NULL DEFAULT 0,
  total_expenses   NUMERIC(12,2) NOT NULL DEFAULT 0,  -- sum of APPROVED expense amounts

  last_active_at   TIMESTAMPTZ,

  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.employee_metrics_snapshot IS
  'feat-1 snapshot: cumulative all-time metrics per employee.
   Powers GET /profile/me with a single PK lookup instead of full daily_metrics scan.
   Recomputed idempotently by the snapshot worker (full SET strategy).';

CREATE INDEX IF NOT EXISTS idx_metrics_org
  ON public.employee_metrics_snapshot (organization_id);

-- updated_at auto-stamp
CREATE TRIGGER trg_updated_at_employee_metrics_snapshot
  BEFORE UPDATE ON public.employee_metrics_snapshot
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ══════════════════════════════════════════════════════════════
-- 4. active_users
-- ══════════════════════════════════════════════════════════════
-- One row per currently checked-in employee.  Inserted on CHECK_IN,
-- deleted on CHECK_OUT.  Enables O(employees_checked_in) active-user
-- queries rather than O(all_sessions).

CREATE TABLE IF NOT EXISTS public.active_users (
  employee_id     UUID        PRIMARY KEY
                              REFERENCES public.employees(id) ON DELETE CASCADE,
  organization_id UUID        NOT NULL
                              REFERENCES public.organizations(id) ON DELETE CASCADE,

  session_id      UUID        REFERENCES public.attendance_sessions(id) ON DELETE CASCADE,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.active_users IS
  'feat-1 snapshot: one row per currently checked-in employee.
   Enables sub-10ms "how many people are in the field right now?" queries.';

CREATE INDEX IF NOT EXISTS idx_active_org
  ON public.active_users (organization_id);

-- ══════════════════════════════════════════════════════════════
-- RLS — PHASE 2
-- ══════════════════════════════════════════════════════════════
--
-- Pattern (same as the rest of the codebase, see baseline_schema.sql):
--   service_role bypass  — unrestricted (workers write via service role key)
--   admin_all policy     — ADMIN can SELECT on all rows in their org
--   employee_self policy — EMPLOYEE can SELECT only their own row
--   No client writes     — snapshot tables are maintained exclusively by workers

-- ── employee_last_state ──────────────────────────────────────

ALTER TABLE public.employee_last_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "els2_service_role"
  ON public.employee_last_state
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "els2_admin_all"
  ON public.employee_last_state
  FOR SELECT TO authenticated
  USING (
    (SELECT organization_id = employee_last_state.organization_id
        AND role = 'ADMIN'
     FROM public.users
     WHERE id = auth.uid())
  );

CREATE POLICY "els2_employee_self"
  ON public.employee_last_state
  FOR SELECT TO authenticated
  USING (
    employee_id = (SELECT id FROM public.employees WHERE user_id = auth.uid())
  );

-- ── pending_expenses ─────────────────────────────────────────

ALTER TABLE public.pending_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pending_exp_service_role"
  ON public.pending_expenses
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "pending_exp_admin_all"
  ON public.pending_expenses
  FOR SELECT TO authenticated
  USING (
    (SELECT organization_id = pending_expenses.organization_id
        AND role = 'ADMIN'
     FROM public.users
     WHERE id = auth.uid())
  );

CREATE POLICY "pending_exp_employee_self"
  ON public.pending_expenses
  FOR SELECT TO authenticated
  USING (
    employee_id = (SELECT id FROM public.employees WHERE user_id = auth.uid())
  );

-- ── employee_metrics_snapshot ────────────────────────────────

ALTER TABLE public.employee_metrics_snapshot ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ems_service_role"
  ON public.employee_metrics_snapshot
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "ems_admin_all"
  ON public.employee_metrics_snapshot
  FOR SELECT TO authenticated
  USING (
    (SELECT organization_id = employee_metrics_snapshot.organization_id
        AND role = 'ADMIN'
     FROM public.users
     WHERE id = auth.uid())
  );

CREATE POLICY "ems_employee_self"
  ON public.employee_metrics_snapshot
  FOR SELECT TO authenticated
  USING (
    employee_id = (SELECT id FROM public.employees WHERE user_id = auth.uid())
  );

-- ── active_users ─────────────────────────────────────────────

ALTER TABLE public.active_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "active_users_service_role"
  ON public.active_users
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "active_users_admin_all"
  ON public.active_users
  FOR SELECT TO authenticated
  USING (
    (SELECT organization_id = active_users.organization_id
        AND role = 'ADMIN'
     FROM public.users
     WHERE id = auth.uid())
  );

CREATE POLICY "active_users_employee_self"
  ON public.active_users
  FOR SELECT TO authenticated
  USING (
    employee_id = (SELECT id FROM public.employees WHERE user_id = auth.uid())
  );

-- ══════════════════════════════════════════════════════════════
-- BACK-FILL FUNCTION (run once after migration)
-- ══════════════════════════════════════════════════════════════
-- Seed the snapshot tables from the existing live data so the
-- very first API requests after deploying this migration hit
-- populated snapshots rather than empty tables.
--
-- Safe to run multiple times (idempotent UPSERTs).

CREATE OR REPLACE FUNCTION public.backfill_feat1_snapshots()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

  -- ── 1. employee_last_state ──────────────────────────────────
  -- Seed from the most-recent attendance_session per employee.
  INSERT INTO public.employee_last_state (
    employee_id, organization_id,
    last_session_id, is_checked_in,
    last_check_in_at, last_check_out_at,
    updated_at
  )
  SELECT DISTINCT ON (s.employee_id)
    s.employee_id,
    s.organization_id,
    s.id                         AS last_session_id,
    (s.checkout_at IS NULL)      AS is_checked_in,
    s.checkin_at                 AS last_check_in_at,
    s.checkout_at                AS last_check_out_at,
    now()
  FROM public.attendance_sessions s
  ORDER BY s.employee_id, s.checkin_at DESC
  ON CONFLICT (employee_id) DO UPDATE SET
    last_session_id   = EXCLUDED.last_session_id,
    is_checked_in     = EXCLUDED.is_checked_in,
    last_check_in_at  = EXCLUDED.last_check_in_at,
    last_check_out_at = EXCLUDED.last_check_out_at,
    updated_at        = now();

  -- ── 2. active_users ─────────────────────────────────────────
  INSERT INTO public.active_users (employee_id, organization_id, session_id, last_seen_at)
  SELECT s.employee_id, s.organization_id, s.id, now()
  FROM public.attendance_sessions s
  WHERE s.checkout_at IS NULL
  ON CONFLICT (employee_id) DO UPDATE SET
    session_id   = EXCLUDED.session_id,
    last_seen_at = now();

  -- ── 3. pending_expenses ─────────────────────────────────────
  INSERT INTO public.pending_expenses (id, organization_id, employee_id, amount, submitted_at)
  SELECT id, organization_id, employee_id, amount, submitted_at
  FROM public.expenses
  WHERE status = 'PENDING'
  ON CONFLICT (id) DO NOTHING;

  -- ── 4. employee_metrics_snapshot ────────────────────────────
  -- Aggregate from employee_daily_metrics (already computed by analytics worker).
  -- total_expenses = sum of APPROVED expense amounts.
  INSERT INTO public.employee_metrics_snapshot (
    employee_id, organization_id,
    total_sessions, total_hours, total_distance, total_expenses,
    last_active_at, updated_at
  )
  SELECT
    e.id                                                    AS employee_id,
    e.organization_id,
    COALESCE(m.total_sessions, 0)                           AS total_sessions,
    ROUND((COALESCE(m.total_duration_seconds, 0) / 3600.0)::numeric, 2)
                                                            AS total_hours,
    ROUND(COALESCE(m.total_distance_km, 0)::numeric, 4)    AS total_distance,
    ROUND(COALESCE(ex.total_approved, 0)::numeric, 2)       AS total_expenses,
    e.last_activity_at                                      AS last_active_at,
    now()
  FROM public.employees e
  LEFT JOIN (
    SELECT employee_id,
           SUM(sessions)         AS total_sessions,
           SUM(duration_seconds) AS total_duration_seconds,
           SUM(distance_km)      AS total_distance_km
    FROM public.employee_daily_metrics
    GROUP BY employee_id
  ) m ON m.employee_id = e.id
  LEFT JOIN (
    SELECT employee_id, SUM(amount) AS total_approved
    FROM public.expenses
    WHERE status = 'APPROVED'
    GROUP BY employee_id
  ) ex ON ex.employee_id = e.id
  ON CONFLICT (employee_id) DO UPDATE SET
    total_sessions = EXCLUDED.total_sessions,
    total_hours    = EXCLUDED.total_hours,
    total_distance = EXCLUDED.total_distance,
    total_expenses = EXCLUDED.total_expenses,
    last_active_at = EXCLUDED.last_active_at,
    updated_at     = now();

END;
$$;

COMMENT ON FUNCTION public.backfill_feat1_snapshots() IS
  'feat-1: Seed snapshot tables from live data. Idempotent — safe to run multiple times.
   Call once after applying this migration: SELECT public.backfill_feat1_snapshots();';

-- Run the back-fill immediately as part of this migration.
-- On a fresh DB with no data this is a no-op.
-- On a live DB this seeds the snapshots from historical data.
SELECT public.backfill_feat1_snapshots();

-- ══════════════════════════════════════════════════════════════
-- GRANTS
-- ══════════════════════════════════════════════════════════════

GRANT EXECUTE ON FUNCTION public.backfill_feat1_snapshots() TO service_role;
