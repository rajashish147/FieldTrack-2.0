import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { expensesController } from "./expenses.controller.js";
import {
  createExpenseBodySchema,
  expensePaginationSchema,
  updateExpenseStatusBodySchema,
} from "./expenses.schema.js";

const unknownObject = z.object({}).passthrough();

const singleExpenseResponseSchema = z.object({
  success: z.literal(true),
  data: unknownObject,
});

const expenseListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(unknownObject),
});

/**
 * Expense routes.
 *
 * EMPLOYEE endpoints:
 *   POST  /expenses          — create a new expense (rate-limited per user)
 *   GET   /expenses/my       — list own expenses (paginated)
 *
 * ADMIN endpoints:
 *   GET   /admin/expenses    — list all org expenses (paginated)
 *   PATCH /admin/expenses/:id — approve or reject a PENDING expense
 */
export async function expensesRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/expenses",
    {
      schema: { tags: ["expenses"], body: createExpenseBodySchema, response: { 201: singleExpenseResponseSchema } },
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60_000,
          keyGenerator: (req: FastifyRequest): string => req.user?.sub ?? req.ip,
        },
      },
      // No role restriction — admins who also have an employee record can submit
      // expenses. The service layer's requireEmployeeContext() guard rejects any
      // authenticated user who has no employees row (403).
      preValidation: [authenticate],
    },
    expensesController.create,
  );

  app.get(
    "/expenses/my",
    {
      schema: {
        tags: ["expenses"],
        querystring: expensePaginationSchema,
        response: { 200: expenseListResponseSchema },
      },
      // No role restriction — service returns [] when employeeId is absent (admin users)
      preValidation: [authenticate],
    },
    expensesController.getMy,
  );

  app.get(
    "/admin/expenses",
    {
      schema: {
        tags: ["admin"],
        querystring: expensePaginationSchema,
        response: { 200: expenseListResponseSchema },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    expensesController.getOrgAll,
  );

  app.patch<{ Params: { id: string } }>(
    "/admin/expenses/:id",
    {
      schema: { tags: ["admin"], body: updateExpenseStatusBodySchema, response: { 200: singleExpenseResponseSchema } },
      // preValidation ensures auth/role fires before body validation
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    expensesController.updateStatus,
  );
}
