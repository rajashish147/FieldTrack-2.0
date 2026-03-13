import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { employeesController } from "./employees.controller.js";
import { createEmployeeBodySchema } from "./employees.schema.js";

const employeeResponseSchema = z.object({
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
 * POST /admin/employees — create a new employee (employee_code required)
 */
export async function employeesRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/admin/employees",
    {
      schema: { tags: ["admin"], body: createEmployeeBodySchema, response: { 201: employeeResponseSchema } },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    employeesController.create,
  );
}
