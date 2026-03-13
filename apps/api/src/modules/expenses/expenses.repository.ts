import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import { orgTable } from "../../db/query.js";
import { applyPagination } from "../../utils/pagination.js";
import type { FastifyRequest } from "fastify";
import type { Expense, ExpenseStatus, CreateExpenseBody } from "./expenses.schema.js";

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
  ): Promise<{ data: EnrichedExpense[]; total: number }> {
    const { data, error, count } = await applyPagination(
      orgTable(request, "expenses")
        .select(EXPENSE_ENRICHED_COLS, { count: "exact" })
        .order("submitted_at", { ascending: false }),
      page,
      limit,
    );

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
  ): Promise<EnrichedExpense> {
    const now = new Date().toISOString();

    const { data, error } = await orgTable(request, "expenses")
      .update({ status, reviewed_at: now, reviewed_by: reviewerId })
      .eq("id", expenseId)
      .select(EXPENSE_ENRICHED_COLS)
      .single();

    if (error) {
      throw new Error(`Failed to update expense status: ${error.message}`);
    }
    return flattenEmployee(data as Record<string, unknown>);
  },
};
