import type { FastifyRequest, FastifyReply } from "fastify";
import { expensesService } from "./expenses.service.js";
import {
  createExpenseBodySchema,
  updateExpenseStatusBodySchema,
  expensePaginationSchema,
} from "./expenses.schema.js";
import { ok, fail, paginated, handleError } from "../../utils/response.js";

/**
 * Expenses controller — parses/validates request data, delegates to service,
 * returns consistent { success, data } responses.
 */
export const expensesController = {
  /**
   * POST /expenses
   * Creates a new expense for the authenticated employee.
   */
  async create(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const parsed = createExpenseBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => i.message).join("; ");
        reply.status(400).send(fail(`Validation failed: ${issues}`, request.id));
        return;
      }

      const expense = await expensesService.createExpense(request, parsed.data);
      reply.status(201).send(ok(expense));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error creating expense");
    }
  },

  /**
   * GET /expenses/my
   * Returns the authenticated employee's own expenses (paginated).
   */
  async getMy(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const parsed = expensePaginationSchema.parse(request.query);
      const result = await expensesService.getMyExpenses(
        request,
        parsed.page,
        parsed.limit,
      );
      reply.status(200).send(paginated(result.data, parsed.page, parsed.limit, result.total));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error fetching user expenses");
    }
  },

  /**
   * GET /admin/expenses
   * Returns all expenses across the organization (ADMIN only, paginated).
   */
  async getOrgAll(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const parsed = expensePaginationSchema.parse(request.query);
      const result = await expensesService.getOrgExpenses(
        request,
        parsed.page,
        parsed.limit,
      );
      reply.status(200).send(paginated(result.data, parsed.page, parsed.limit, result.total));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error fetching org expenses");
    }
  },

  /**
   * PATCH /admin/expenses/:id
   * Approve or reject a PENDING expense (ADMIN only).
   */
  async updateStatus(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const { id } = request.params;

      const parsed = updateExpenseStatusBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => i.message).join("; ");
        reply.status(400).send(fail(`Validation failed: ${issues}`, request.id));
        return;
      }

      const expense = await expensesService.updateExpenseStatus(
        request,
        id,
        parsed.data,
      );
      reply.status(200).send(ok(expense));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error updating expense status");
    }
  },
};
