import { z } from "zod";
import type { Employee } from "../../types/db.js";

export type { Employee };

export const createEmployeeBodySchema = z.object({
  name: z.string().min(1, { message: "name is required" }),
  // employee_code is now optional — the API auto-generates one from the sequence
  // when omitted. Providing an explicit code is still supported (e.g. migrations).
  employee_code: z.string().min(1).optional(),
  user_id: z.string().uuid({ message: "user_id must be a valid UUID" }).optional(),
  phone: z.string().optional(),
});

export type CreateEmployeeBody = z.infer<typeof createEmployeeBodySchema>;

export const updateEmployeeBodySchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().nullable().optional(),
});

export type UpdateEmployeeBody = z.infer<typeof updateEmployeeBodySchema>;

export const employeeListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Filter by active/inactive status. Omit to return all. */
  active: z.enum(["true", "false"]).optional(),
  /** Partial name search (case-insensitive). */
  search: z.string().optional(),
});

export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;
