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
  const { employees: _emp, ...rest } = row;
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
    const { data, error, count } = await applyPagination(
      orgTable(request, "expenses")
        .select(EXPENSE_ENRICHED_COLS, { count: "exact" })
        .eq("employee_id", employeeId)
        .order("submitted_at", { ascending: false }),
      page,
      limit,
    );

    if (error) {
      throw new Error(`Failed to fetch user expenses: ${error.message}`);
    }
    return {
      data: ((data ?? []) as Array<Record<string, unknown>>).map(flattenEmployee),
      total: count ?? 0,
    };
  },

  async findExpensesByOrg(
    request: FastifyRequest,
    page: number,
    limit: number,
    employeeId?: string,
  ): Promise<{ data: EnrichedExpense[]; total: number }> {
    let baseQuery = orgTable(request, "expenses")
      .select(EXPENSE_ENRICHED_COLS, { count: "exact" })
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
   * Returns one summary row per employee with pending/total expense aggregates.
   * Sorted: employees with pending expenses first, then by latest expense date DESC.
   * O(distinct employees) — significantly faster than returning all expense rows.
   */
  async findExpenseSummaryByEmployee(
    request: FastifyRequest,
    page: number,
    limit: number,
  ): Promise<{ data: EmployeeExpenseSummary[]; total: number }> {
    // Fetch the full (org-scoped) expense list with employee info.
    // We group in application code to avoid a raw SQL RPC; the expense
    // table is orders of magnitude smaller than attendance_sessions.
    // No limit applied — expenses per org are bounded by org size × submission rate
    // and the pagination happens after in-memory grouping by employee.
    const { data, error } = await orgTable(request, "expenses")
      .select(EXPENSE_ENRICHED_COLS)
      .order("submitted_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch expense summary: ${error.message}`);
    }

    const rows = ((data ?? []) as Array<Record<string, unknown>>).map(flattenEmployee);

    // Aggregate per employee
    const map = new Map<string, EmployeeExpenseSummary>();
    for (const row of rows) {
      const empId = row.employee_id as string;
      const existing = map.get(empId);
      const amount = row.amount as number;
      const isPending = row.status === "PENDING";

      if (!existing) {
        map.set(empId, {
          employeeId: empId,
          employeeName: row.employee_name ?? `Employee …${empId.slice(-4)}`,
          employeeCode: row.employee_code ?? null,
          pendingCount: isPending ? 1 : 0,
          pendingAmount: isPending ? amount : 0,
          totalCount: 1,
          totalAmount: amount,
          latestExpenseDate: row.submitted_at as string,
        });
      } else {
        existing.totalCount++;
        existing.totalAmount += amount;
        if (isPending) {
          existing.pendingCount++;
          existing.pendingAmount += amount;
        }
      }
    }

    // Sort: pending first, then by latest expense date
    const groups = [...map.values()].sort((a, b) => {
      if (b.pendingCount !== a.pendingCount) return b.pendingCount - a.pendingCount;
      return (b.latestExpenseDate ?? "").localeCompare(a.latestExpenseDate ?? "");
    });

    // Round amounts
    for (const g of groups) {
      g.pendingAmount = Math.round(g.pendingAmount * 100) / 100;
      g.totalAmount = Math.round(g.totalAmount * 100) / 100;
    }

    const total = groups.length;
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safeOffset = (Math.max(1, page) - 1) * safeLimit;
    return { data: groups.slice(safeOffset, safeOffset + safeLimit), total };
  },
};
