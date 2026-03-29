import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import { orgTable } from "../../db/query.js";
import { applyPagination } from "../../utils/pagination.js";
import type { FastifyRequest } from "fastify";
import type { Expense, ExpenseStatus, CreateExpenseBody } from "./expenses.schema.js";
import type { EmployeeExpenseSummary } from "@fieldtrack/types";

/** Enriched expense returned by list queries — adds employee code and name. */
export type EnrichedExpense = Expense & {
  employee_code: string | null;
  employee_name: string | null;
};

/** Columns always selected for a single expense row (no join). */
const EXPENSE_COLS = "id, organization_id, employee_id, amount, description, status, receipt_url, submitted_at, reviewed_at, reviewed_by, created_at, updated_at";

/** Columns selected when joining employees for enriched responses. */
const EXPENSE_ENRICHED_COLS = `${EXPENSE_COLS}, employees!expenses_employee_id_fkey(name, employee_code)`;

function flattenEmployee(row: Record<string, unknown>): EnrichedExpense {
  const emp = row.employees as { name?: string; employee_code?: string } | null;
  const { employees: _, ...rest } = row;
  return {
    ...rest,
    employee_name: emp?.name ?? null,
    employee_code: emp?.employee_code ?? null,
  } as EnrichedExpense;
}
export const expensesRepository = {
  async createExpense(
    request: FastifyRequest,
    employeeId: string,
    body: CreateExpenseBody,
  ): Promise<Expense> {
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("expenses")
      .insert({
        organization_id: request.organizationId,
        employee_id: employeeId,
        amount: body.amount,
        description: body.description,
        receipt_url: body.receipt_url ?? null,
        status: "PENDING",
        submitted_at: now,
      })
      .select(EXPENSE_COLS)
      .single();

    if (error) {
      throw new Error(`Failed to create expense: ${error.message}`);
    }
    return data as Expense;
  },

  async findExpenseById(
    request: FastifyRequest,
    expenseId: string,
  ): Promise<Expense | null> {
    const { data, error } = await orgTable(request, "expenses")
      .select(EXPENSE_COLS)
      .eq("id", expenseId)
      .single();

    if (error && error.code === "PGRST116") return null;
    if (error) {
      throw new Error(`Failed to fetch expense: ${error.message}`);
    }
    return data as Expense;
  },

  async findExpensesByUser(
    request: FastifyRequest,
    employeeId: string,
    page: number,
    limit: number,
  ): Promise<{ data: EnrichedExpense[]; total: number }> {
    // Phase 30: removed employees join (caller already knows their own identity).
    // count:"estimated" eliminates the shadow SELECT COUNT(*) on every list call.
    // Index idx_expenses_org_emp_submitted (org_id, emp_id, submitted_at DESC)
    // covers both the WHERE clause and the ORDER BY in a single index scan.
    const { data, error, count } = await applyPagination(
      orgTable(request, "expenses")
        .select(EXPENSE_COLS, { count: "estimated" })
        .eq("employee_id", employeeId)
        .order("submitted_at", { ascending: false }),
      page,
      limit,
    );

    if (error) {
      throw new Error(`Failed to fetch user expenses: ${error.message}`);
    }
    return {
      data: ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        ...(row as Expense),
        employee_name: null,
        employee_code: null,
      })),
      total: count ?? 0,
    };
  },

  async findExpensesByOrg(
    request: FastifyRequest,
    page: number,
    limit: number,
    employeeId?: string,
  ): Promise<{ data: EnrichedExpense[]; total: number }> {
    // Phase 30: count:"estimated" eliminates the shadow SELECT COUNT(*) query.
    // idx_expenses_org_submitted_desc (org_id, submitted_at DESC) covers the
    // org-wide list; idx_expenses_org_emp_submitted covers the per-employee filter.
    let baseQuery = orgTable(request, "expenses")
      .select(EXPENSE_ENRICHED_COLS, { count: "estimated" })
      .order("submitted_at", { ascending: false });

    if (employeeId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      baseQuery = (baseQuery as any).eq("employee_id", employeeId);
    }

    const { data, error, count } = await applyPagination(baseQuery, page, limit);

    if (error) {
      throw new Error(`Failed to fetch org expenses: ${error.message}`);
    }
    return {
      data: ((data ?? []) as Array<Record<string, unknown>>).map(flattenEmployee),
      total: count ?? 0,
    };
  },

  async updateExpenseStatus(
    request: FastifyRequest,
    expenseId: string,
    status: ExpenseStatus,
    reviewerId: string,
    rejectionComment?: string,
  ): Promise<EnrichedExpense> {
    const now = new Date().toISOString();

    const updatePayload: Record<string, unknown> = { status, reviewed_at: now, reviewed_by: reviewerId };
    if (status === "REJECTED" && rejectionComment) {
      updatePayload.rejection_comment = rejectionComment;
    }

    const { data, error } = await orgTable(request, "expenses")
      .update(updatePayload)
      .eq("id", expenseId)
      .select(EXPENSE_ENRICHED_COLS)
      .single();

    if (error) {
      throw new Error(`Failed to update expense status: ${error.message}`);
    }
    return flattenEmployee(data as Record<string, unknown>);
  },

  /**
   * Returns one aggregated row per employee with pending/total expense metrics.
   * Sorted: employees with ≥1 PENDING expense first, then by latest submitted_at DESC.
   *
   * Phase 30: replaced the previous 50 000-row in-memory GROUP BY with a DB-side
   * SQL aggregation via get_expense_summary_by_employee().  The function runs a
   * single indexed GROUP BY on the expenses table and joins employees once —
   * O(distinct employees) instead of O(total expenses).
   */
  async findExpenseSummaryByEmployee(
    request: FastifyRequest,
    page: number,
    limit: number,
  ): Promise<{ data: EmployeeExpenseSummary[]; total: number }> {
    const { data, error } = await supabase.rpc("get_expense_summary_by_employee", {
      p_org_id: request.organizationId,
    });

    if (error) {
      throw new Error(`Failed to fetch expense summary: ${error.message}`);
    }

    type SummaryRow = {
      employee_id: string;
      employee_name: string;
      employee_code: string | null;
      pending_count: number | string;
      pending_amount: number | string;
      total_count: number | string;
      total_amount: number | string;
      latest_expense_date: string | null;
    };

    const groups: EmployeeExpenseSummary[] = ((data ?? []) as SummaryRow[]).map((row) => ({
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      employeeCode: row.employee_code,
      pendingCount: Number(row.pending_count),
      pendingAmount: Math.round(Number(row.pending_amount) * 100) / 100,
      totalCount: Number(row.total_count),
      totalAmount: Math.round(Number(row.total_amount) * 100) / 100,
      latestExpenseDate: row.latest_expense_date,
    }));

    const total = groups.length;
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safeOffset = (Math.max(1, page) - 1) * safeLimit;
    return { data: groups.slice(safeOffset, safeOffset + safeLimit), total };
  },
};
