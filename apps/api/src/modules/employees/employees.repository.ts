import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import type { FastifyRequest } from "fastify";
import type { Employee } from "../../types/db.js";
import type { CreateEmployeeBody } from "./employees.schema.js";
import { BadRequestError } from "../../utils/errors.js";

const EMPLOYEE_COLS =
  "id, organization_id, user_id, name, employee_code, phone, is_active, created_at, updated_at";

export const employeesRepository = {
  /**
   * Insert a new employee row.
   * employee_code is NOT NULL in the database — it must be provided in body.
   */
  async createEmployee(
    request: FastifyRequest,
    body: CreateEmployeeBody,
  ): Promise<Employee> {
    const { data, error } = await supabase
      .from("employees")
      .insert({
        organization_id: request.organizationId,
        name: body.name,
        employee_code: body.employee_code,
        user_id: body.user_id ?? null,
        phone: body.phone ?? null,
      })
      .select(EMPLOYEE_COLS)
      .single();

    if (error) {
      if (error.code === "23503") {
        throw new BadRequestError(
          `user_id '${body.user_id}' does not correspond to any registered user`,
        );
      }
      if (error.code === "23505") {
        throw new BadRequestError(
          `employee_code '${body.employee_code}' is already in use within this organization`,
        );
      }
      throw new Error(`Failed to create employee: ${error.message}`);
    }
    return data as Employee;
  },
};
