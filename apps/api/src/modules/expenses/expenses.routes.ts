import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Expense } from "@fieldtrack/types";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { expensesController } from "./expenses.controller.js";
import {
  createExpenseBodySchema,
  expensePaginationSchema,
  updateExpenseStatusBodySchema,
} from "./expenses.schema.js";

const expenseItemSchema: z.ZodType<Expense> = z.object({
  id: z.string(),
  employee_id: z.string(),
  organization_id: z.string(),
  amount: z.number(),
  description: z.string(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
  receipt_url: z.string().nullable(),
  submitted_at: z.string(),
  reviewed_at: z.string().nullable(),
  reviewed_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  // Enriched fields — present on list queries
  employee_code: z.string().nullable().optional(),
  employee_name: z.string().nullable().optional(),
});

const singleExpenseResponseSchema = z.object({
  success: z.literal(true),
  data: expenseItemSchema,
});

const paginationMetaSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
});

const expenseListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(expenseItemSchema),
  pagination: paginationMetaSchema,
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
      schema: { tags: ["expenses"], body: createExpenseBodySchema, response: { 201: singleExpenseResponseSchema.describe("Created expense record") } },
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
        response: { 200: expenseListResponseSchema.describe("Employee's own expense records") },
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
        response: { 200: expenseListResponseSchema.describe("All organization expense records") },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    expensesController.getOrgAll,
  );

  app.patch<{ Params: { id: string } }>(
    "/admin/expenses/:id",
    {
      schema: { tags: ["admin"], body: updateExpenseStatusBodySchema, response: { 200: singleExpenseResponseSchema.describe("Updated expense record") } },
      // preValidation ensures auth/role fires before body validation
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    expensesController.updateStatus,
  );
}
