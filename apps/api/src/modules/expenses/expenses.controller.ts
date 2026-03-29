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
      const response = paginated(result.data, parsed.page, parsed.limit, result.total);
      const payloadBytes = Buffer.byteLength(JSON.stringify(response));
      request.log.info(
        { route: "/expenses/my", payloadBytes, expenseCount: result.data.length },
        "phase30:expenses-my",
      );
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, request, reply, "Unexpected error fetching user expenses");
    }
  },

  /**
   * GET /admin/expenses
   * Returns all expenses across the organization (ADMIN only, paginated).
   * Accepts optional ?employee_id=<uuid> to scope to a single employee.
   */
  async getOrgAll(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const parsed = expensePaginationSchema.parse(request.query);
      const query = request.query as Record<string, string | undefined>;
      const employeeId = query.employee_id;
      const result = await expensesService.getOrgExpenses(
        request,
        parsed.page,
        parsed.limit,
        employeeId,
      );
      const response = paginated(result.data, parsed.page, parsed.limit, result.total);
      const payloadBytes = Buffer.byteLength(JSON.stringify(response));
      request.log.info(
        { route: "/admin/expenses", payloadBytes, expenseCount: result.data.length },
        "phase30:admin-expenses",
      );
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, request, reply, "Unexpected error fetching org expenses");
    }
  }

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

  /**
   * POST /expenses/receipt-upload-url
   * Returns a short-lived signed upload URL for a receipt file.
   * The client uploads directly to Supabase Storage — the API never handles
   * file bytes. Receipt URL is derived from the storage path and should be
   * included in the expense creation payload as receipt_url.
   */
  async getReceiptUploadUrl(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const body = request.body as Record<string, unknown> | undefined;
      const extension = typeof body?.extension === "string" ? body.extension : "";
      const mimeType = typeof body?.mimeType === "string" ? body.mimeType : undefined;

      const result = await expensesService.generateReceiptUploadUrl(request, extension, mimeType);
      reply.status(200).send(ok(result));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error generating receipt upload URL");
    }
  },
};
