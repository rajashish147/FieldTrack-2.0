import type { FastifyRequest } from "fastify";
import { expensesRepository } from "./expenses.repository.js";
import { BadRequestError, ExpenseAlreadyReviewed, NotFoundError, requireEmployeeContext } from "../../utils/errors.js";
import type {
  Expense,
  CreateExpenseBody,
  UpdateExpenseStatusBody,
} from "./expenses.schema.js";
import type { EnrichedExpense } from "./expenses.repository.js";
import { profileRepository } from "../profile/profile.repository.js";
import { analyticsMetricsRepository } from "../analytics/analytics.metrics.repository.js";
import { invalidateOrgAnalytics } from "../../utils/cache.js";
import { sseEventBus } from "../../utils/sse-emitter.js";
import { emitEvent } from "../../utils/event-bus.js";

/**
 * Expenses service — business rules for expense management.
 *
 * Phase: employeeId resolved once in auth middleware (request.employeeId).
 * The attendanceRepository import has been removed.
 *
 * EMPLOYEE rules:
 *  - Can create an expense (status always starts as PENDING).
 *  - Can view only their own expenses.
 *  - Cannot modify an expense after creation.
 *
 * ADMIN rules:
 *  - Can view all org expenses.
 *  - Can approve or reject a PENDING expense.
 *  - Cannot act on expenses from other organizations (enforced via enforceTenant()).
 */
export const expensesService = {
  /**
   * Create a new expense for the authenticated employee.
   * Status is always PENDING on creation — no override allowed.
   */
  async createExpense(
    request: FastifyRequest,
    body: CreateExpenseBody,
  ): Promise<Expense> {
    requireEmployeeContext(request);
    const employeeId = request.employeeId;

    const expense = await expensesRepository.createExpense(
      request,
      employeeId,
      body,
    );

    // Update last_activity_at (fire-and-forget)
    profileRepository.updateLastActivity(request, employeeId).catch(() => {});

    // UPSERT employee_daily_metrics + invalidate analytics cache (fire-and-forget)
    const today = new Date().toISOString().substring(0, 10);
    analyticsMetricsRepository
      .upsertEmployeeDailyExpenseMetrics({
        organizationId: request.organizationId,
        employeeId,
        date: today,
        amountDelta: expense.amount,
      })
      .then(() => invalidateOrgAnalytics(request.organizationId))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.warn(
          { expenseId: expense.id, employeeId, error: msg },
          "Failed to update daily analytics after expense creation",
        );
      });

    request.log.info(
      {
        event: "expense_created",
        expenseId: expense.id,
        userId: request.user.sub,
        employeeId,
        organizationId: request.organizationId,
        amount: expense.amount,
      },
      "Expense created",
    );

    sseEventBus.emitOrgEvent(request.organizationId, "expense.created", {
      expenseId: expense.id,
      employeeId,
      amount: expense.amount,
    });

    emitEvent("expense.created", {
      organization_id: request.organizationId,
      data: {
        expense_id:   expense.id,
        employee_id:  employeeId,
        amount:       expense.amount,
        description:  expense.description,
        submitted_at: expense.submitted_at,
      },
    });

    return expense;
  },

  /**
   * Retrieve a paginated list of the authenticated employee's own expenses.
   */
  async getMyExpenses(
    request: FastifyRequest,
    page: number,
    limit: number,
  ): Promise<{ data: EnrichedExpense[]; total: number }> {
    const employeeId = request.employeeId;
    if (!employeeId) return { data: [], total: 0 };

    return expensesRepository.findExpensesByUser(request, employeeId, page, limit);
  },

  /**
   * Retrieve a paginated list of all expenses in the organization.
   * Caller must hold ADMIN role — enforced at the route level.
   * Optionally scoped to a single employee for the admin expense detail panel.
   */
  async getOrgExpenses(
    request: FastifyRequest,
    page: number,
    limit: number,
    employeeId?: string,
  ): Promise<{ data: EnrichedExpense[]; total: number }> {
    return expensesRepository.findExpensesByOrg(request, page, limit, employeeId);
  },

  /**
   * Update the status of an expense (APPROVED or REJECTED).
   * Only PENDING expenses may be actioned — guards against double-processing.
   * Caller must hold ADMIN role — enforced at the route level.
   */
  async updateExpenseStatus(
    request: FastifyRequest,
    expenseId: string,
    body: UpdateExpenseStatusBody,
  ): Promise<Expense> {
    // 1. Fetch the expense — enforces tenant isolation via enforceTenant().
    const expense = await expensesRepository.findExpenseById(
      request,
      expenseId,
    );

    if (!expense) {
      throw new NotFoundError("Expense not found");
    }

    // 2. Only PENDING expenses may be transitioned.
    if (expense.status !== "PENDING") {
      throw new ExpenseAlreadyReviewed(expense.status);
    }

    // 3. Validate: rejection_comment is required when status is REJECTED.
    if (body.status === "REJECTED" && !body.rejection_comment) {
      throw new BadRequestError("rejection_comment is required when rejecting an expense");
    }

    // 4. Apply the new status, recording the reviewer identity.
    const updated = await expensesRepository.updateExpenseStatus(
      request,
      expenseId,
      body.status,
      request.user.sub,
      body.rejection_comment,
    );

    // 5. Structured log with event tag for observability.
    const event =
      body.status === "APPROVED" ? "expense_approved" : "expense_rejected";

    request.log.info(
      {
        event,
        expenseId: updated.id,
        employeeId: updated.employee_id,
        adminId: request.user.sub,
        organizationId: request.organizationId,
        amount: updated.amount,
        status: updated.status,
      },
      body.status === "APPROVED" ? "Expense approved" : "Expense rejected",
    );

    sseEventBus.emitOrgEvent(request.organizationId, "expense.status", {
      expenseId: updated.id,
      employeeId: updated.employee_id,
      status: updated.status,
    });

    if (body.status === "APPROVED") {
      emitEvent("expense.approved", {
        organization_id: request.organizationId,
        data: {
          expense_id:  updated.id,
          employee_id: updated.employee_id,
          amount:      updated.amount,
          description: updated.description,
          approved_by: request.user.sub,
          reviewed_at: updated.reviewed_at ?? new Date().toISOString(),
        },
      });
    } else if (body.status === "REJECTED") {
      // Phase 25: emit expense.rejected so webhook subscribers receive
      // rejection events on the same code path as approvals.
      emitEvent("expense.rejected", {
        organization_id: request.organizationId,
        data: {
          expense_id:        updated.id,
          employee_id:       updated.employee_id,
          amount:            updated.amount,
          description:       updated.description,
          rejected_by:       request.user.sub,
          reviewed_at:       updated.reviewed_at ?? new Date().toISOString(),
          rejection_comment: body.rejection_comment,
        },
      });
    }

    return updated;
  },
};
