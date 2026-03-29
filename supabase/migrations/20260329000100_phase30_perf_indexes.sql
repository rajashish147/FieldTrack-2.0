-- Phase 30: Query performance optimisation
--
-- Bottlenecks identified:
--   1. GET /expenses/my   — no covering index for (org_id, emp_id, submitted_at DESC)
--   2. GET /admin/expenses — missing DESC variant of (org_id, submitted_at)
--   3. GET /admin/expenses/summary — 50 000-row in-memory GROUP BY replaced by SQL aggregation
--
-- Changes:
--   A. Add two covering composite indexes on expenses.
--   B. Create SQL function get_expense_summary_by_employee() that performs the
--      GROUP BY aggregation on the DB side, eliminating the application-level scan.
--
-- ──────────────────────────────────────────────────────────────────────────────
-- A. INDEXES
-- ──────────────────────────────────────────────────────────────────────────────

-- Covers: WHERE organization_id = ? AND employee_id = ? ORDER BY submitted_at DESC
-- Used by: GET /expenses/my  (findExpensesByUser) and
--           GET /admin/expenses?employee_id=... (findExpensesByOrg with filter)
-- Existing idx_expenses_org_employee (org_id, emp_id) had no ordering column,
-- forcing a post-filter sort.  This eliminates it.
CREATE INDEX IF NOT EXISTS idx_expenses_org_emp_submitted
  ON public.expenses (organization_id, employee_id, submitted_at DESC);

-- Covers: WHERE organization_id = ? ORDER BY submitted_at DESC
-- Used by: GET /admin/expenses (findExpensesByOrg without employee filter)
-- Postgres supports backward B-tree scans so the existing idx_expenses_org_submitted
-- (ASC) could already be used in reverse; the explicit DESC index below ensures the
-- planner always picks an index-only forward scan for the most common admin list.
CREATE INDEX IF NOT EXISTS idx_expenses_org_submitted_desc
  ON public.expenses (organization_id, submitted_at DESC);

-- ──────────────────────────────────────────────────────────────────────────────
-- B. SQL AGGREGATION FUNCTION
-- ──────────────────────────────────────────────────────────────────────────────

-- Replaces the application-level "fetch up to 50 000 rows then GROUP BY" pattern
-- in expensesRepository.findExpenseSummaryByEmployee().
--
-- Returns one row per employee (matching EmployeeExpenseSummary interface).
-- Sorted: employees with ≥1 PENDING expense first, then by latest submitted_at DESC.
-- LEFT JOIN preserves expense rows whose employee_id has been soft-deleted.
-- COALESCE name fallback mirrors the existing JS fallback for missing employee rows.
--
-- Security: called exclusively by supabaseServiceClient (service role), which
-- bypasses RLS.  The p_org_id parameter enforces tenant isolation at the query level.
-- SET search_path = public prevents search-path injection (Phase 29 hardening pattern).

CREATE OR REPLACE FUNCTION get_expense_summary_by_employee(p_org_id UUID)
RETURNS TABLE (
  employee_id         UUID,
  employee_name       TEXT,
  employee_code       TEXT,
  pending_count       BIGINT,
  pending_amount      NUMERIC,
  total_count         BIGINT,
  total_amount        NUMERIC,
  latest_expense_date TIMESTAMPTZ
)
LANGUAGE SQL
STABLE
SET search_path = public
AS $$
  SELECT
    e.employee_id,
    COALESCE(emp.name, 'Employee …' || RIGHT(e.employee_id::TEXT, 4))         AS employee_name,
    emp.employee_code,
    COUNT(*) FILTER (WHERE e.status = 'PENDING')                               AS pending_count,
    COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'PENDING'), 0::NUMERIC)    AS pending_amount,
    COUNT(*)                                                                    AS total_count,
    COALESCE(SUM(e.amount), 0::NUMERIC)                                         AS total_amount,
    MAX(e.submitted_at)                                                         AS latest_expense_date
  FROM public.expenses e
  LEFT JOIN public.employees emp ON emp.id = e.employee_id
  WHERE e.organization_id = p_org_id
  GROUP BY e.employee_id, emp.name, emp.employee_code
  ORDER BY pending_count DESC, latest_expense_date DESC;
$$;
