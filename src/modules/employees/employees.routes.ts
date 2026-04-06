import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { employeesController } from "./employees.controller.js";
import {
  createEmployeeBodySchema,
  updateEmployeeBodySchema,
  employeeListQuerySchema,
} from "./employees.schema.js";

const employeeRowSchema = z.object({
  success: z.literal(true),
  data: z.object({
    id: z.string(),
    organization_id: z.string(),
    user_id: z.string().nullable(),
    name: z.string(),
    employee_code: z.string(),
    phone: z.string().nullable(),
    is_active: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
});

/**
 * Employees management routes — ADMIN only.
 *
 * POST   /admin/employees           — create (employee_code auto-generated when omitted)
 * GET    /admin/employees           — paginated list with optional name search
 * GET    /admin/employees/:id       — single employee
 * PATCH  /admin/employees/:id       — update name/phone
 * PATCH  /admin/employees/:id/status — activate or deactivate
 */
export async function employeesRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/admin/employees",
    {
      schema: {
        tags: ["admin"],
        body: createEmployeeBodySchema,
        response: { 201: employeeRowSchema.describe("Created employee record") },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    employeesController.create,
  );

  app.get(
    "/admin/employees",
    {
      schema: {
        tags: ["admin"],
        querystring: employeeListQuerySchema,
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    employeesController.list,
  );

  app.get<{ Params: { id: string } }>(
    "/admin/employees/:id",
    {
      schema: {
        tags: ["admin"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: employeeRowSchema.describe("Employee record") },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    employeesController.getOne,
  );

  app.patch<{ Params: { id: string } }>(
    "/admin/employees/:id",
    {
      schema: {
        tags: ["admin"],
        params: z.object({ id: z.string().uuid() }),
        body: updateEmployeeBodySchema,
        response: { 200: employeeRowSchema.describe("Updated employee record") },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    employeesController.update,
  );

  app.patch<{ Params: { id: string }; Body: { is_active: boolean } }>(
    "/admin/employees/:id/status",
    {
      schema: {
        tags: ["admin"],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ is_active: z.boolean() }),
        response: { 200: employeeRowSchema.describe("Employee with updated active status") },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    employeesController.setStatus,
  );

  /**
   * GET /admin/search
   * Site-wide search across employees, expenses, and sessions using trigram matching.
   */
  app.get<{ Querystring: { q: string; limit: number } }>(
    "/admin/search",
    {
      schema: {
        tags: ["admin"],
        querystring: z.object({
          q: z.string().min(1).max(200),
          limit: z.coerce.number().int().min(1).max(50).default(10),
        }),
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    employeesController.search,
  );
}

