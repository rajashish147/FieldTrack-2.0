-- Phase: Segmentation performance indexes
--
-- Supports the segmented loading strategy:
--   1. Employees sorted by employee_code — idx_employees_org_code covers the sort
--   2. Sessions segmented by checkout_at — idx_sessions_checkout_at for time-range queries
--   3. Employee last state — idx_els_last_checkout for segment computation
--
-- All indexes are idempotent (IF NOT EXISTS).
-- ──────────────────────────────────────────────────────────────────────────────

-- Covers: WHERE organization_id = ? ORDER BY employee_code ASC
-- Used by: GET /admin/employees (listWithLastState)
-- Previously sorted by name, now sorted by employee_code.
CREATE INDEX IF NOT EXISTS idx_employees_org_code
  ON public.employees (organization_id, employee_code ASC);

-- Covers: checkout_at time-range queries for RECENT segment detection
-- Used by: session status computation (checkout_at > now() - interval '24 hours')
CREATE INDEX IF NOT EXISTS idx_sessions_checkout_at
  ON public.attendance_sessions (checkout_at DESC)
  WHERE checkout_at IS NOT NULL;

-- Covers: last_check_out_at lookups for employee activity segmentation
-- Used by: employee segment computation in listWithLastState
CREATE INDEX IF NOT EXISTS idx_els_last_checkout
  ON public.employee_last_state (last_check_out_at DESC)
  WHERE last_check_out_at IS NOT NULL;
