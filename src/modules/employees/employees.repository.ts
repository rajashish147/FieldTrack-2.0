import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import { orgTable } from "../../db/query.js";
import type { FastifyRequest } from "fastify";
import type { Employee } from "../../types/db.js";
import type { CreateEmployeeBody, UpdateEmployeeBody, EmployeeListQuery } from "./employees.schema.js";
import { BadRequestError } from "../../utils/errors.js";

const EMPLOYEE_COLS =
  "id, organization_id, user_id, name, employee_code, phone, is_active, created_at, updated_at";

/** Generate the next sequential employee code via the DB function. */
async function nextEmployeeCode(prefix = "EMP"): Promise<string> {
  const { data, error } = await supabase.rpc("generate_employee_code", { prefix });
  if (error || !data) throw new Error(`Failed to generate employee code: ${error?.message}`);
  return data as string;
}

export const employeesRepository = {
  /**
   * Insert a new employee row.
   * employee_code is auto-generated from the DB sequence when not supplied.
   */
  async createEmployee(
    request: FastifyRequest,
    body: CreateEmployeeBody,
  ): Promise<Employee> {
    const code = body.employee_code ?? await nextEmployeeCode();

    const { data, error } = await supabase
      .from("employees")
      .insert({
        organization_id: request.organizationId,
        name: body.name,
        employee_code: code,
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
          `employee_code '${code}' is already in use within this organization`,
        );
      }
      throw new Error(`Failed to create employee: ${error.message}`);
    }
    return data as Employee;
  },

  /** Paginated list of employees for the org, with optional name search and status filter. */
  async listEmployees(
    request: FastifyRequest,
    query: EmployeeListQuery,
  ): Promise<{ data: Employee[]; total: number }> {
    const { page, limit, active, search } = query;
    const offset = (page - 1) * limit;

    let q = orgTable(request, "employees")
      .select(EMPLOYEE_COLS, { count: "exact" })
      .order("name", { ascending: true })
      .range(offset, offset + limit - 1);

    if (active !== undefined) {
      q = (q as typeof q).eq("is_active", active === "true");
    }
    if (search) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q = (q as any).ilike("name", `%${search}%`);
    }

    const { data, error, count } = await q;
    if (error) throw new Error(`Failed to list employees: ${error.message}`);
    return { data: (data ?? []) as Employee[], total: count ?? 0 };
  },

  /** Fetch a single employee by id (org-scoped). */
  async findById(
    request: FastifyRequest,
    employeeId: string,
  ): Promise<Employee | null> {
    const { data, error } = await orgTable(request, "employees")
      .select(EMPLOYEE_COLS)
      .eq("id", employeeId)
      .single();

    if (error?.code === "PGRST116") return null;
    if (error) throw new Error(`Failed to fetch employee: ${error.message}`);
    return data as Employee;
  },

  /** Update name / phone for an employee. */
  async updateEmployee(
    request: FastifyRequest,
    employeeId: string,
    body: UpdateEmployeeBody,
  ): Promise<Employee> {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.phone !== undefined) updates.phone = body.phone;

    const { data, error } = await orgTable(request, "employees")
      .update(updates)
      .eq("id", employeeId)
      .select(EMPLOYEE_COLS)
      .single();

    if (error?.code === "PGRST116") throw new Error("Employee not found");
    if (error) throw new Error(`Failed to update employee: ${error.message}`);
    return data as Employee;
  },

  /** Toggle is_active for an employee. */
  async setActiveStatus(
    request: FastifyRequest,
    employeeId: string,
    isActive: boolean,
  ): Promise<Employee> {
    const { data, error } = await orgTable(request, "employees")
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq("id", employeeId)
      .select(EMPLOYEE_COLS)
      .single();

    if (error?.code === "PGRST116") throw new Error("Employee not found");
    if (error) throw new Error(`Failed to update employee status: ${error.message}`);
    return data as Employee;
  },

  /**
   * feat-1: Paginated employee list enriched with real-time check-in state.
   *
   * Joins employee_last_state so the admin employees view shows is_checked_in,
   * last_check_in_at, and last location — all from O(employees) index scans
   * rather than joining attendance_sessions or gps_locations.
   *
   * Falls back to `listEmployees` when the LEFT JOIN returns no state rows
   * (snapshot not yet seeded).
   */
  async listWithLastState(
    request: FastifyRequest,
    query: EmployeeListQuery,
  ): Promise<{
    data: (Employee & {
      is_checked_in: boolean;
      last_check_in_at: string | null;
      last_check_out_at: string | null;
      last_latitude: number | null;
      last_longitude: number | null;
      last_location_at: string | null;
    })[];
    total: number;
    source: "snapshot" | "employees";
  }> {
    const { page, limit, active, search } = query;
    const offset = (page - 1) * limit;

    let q = supabase
      .from("employees")
      .select(
        `${EMPLOYEE_COLS},
         employee_last_state!employee_last_state_employee_id_fkey(
           is_checked_in, last_check_in_at, last_check_out_at,
           last_latitude, last_longitude, last_location_at
         )`,
        { count: "exact" },
      )
      .eq("organization_id", request.organizationId)
      .order("name", { ascending: true })
      .range(offset, offset + limit - 1);

    if (active !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q = (q as any).eq("is_active", active === "true");
    }
    if (search) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q = (q as any).ilike("name", `%${search}%`);
    }

    const { data, error, count } = await q;

    if (error) {
      // Fallback: snapshot join failed — return plain employee list
      const fallback = await this.listEmployees(request, query);
      return {
        ...fallback,
        data: fallback.data.map((e) => ({
          ...e,
          is_checked_in:    false,
          last_check_in_at:  null,
          last_check_out_at: null,
          last_latitude:     null,
          last_longitude:    null,
          last_location_at:  null,
        })),
        source: "employees",
      };
    }

    type EmployeeWithState = Employee & {
      employee_last_state: {
        is_checked_in: boolean;
        last_check_in_at: string | null;
        last_check_out_at: string | null;
        last_latitude: number | null;
        last_longitude: number | null;
        last_location_at: string | null;
      } | null;
    };

    const enriched = ((data ?? []) as unknown as EmployeeWithState[]).map((row) => {
      const { employee_last_state: state, ...employee } = row;
      return {
        ...(employee as Employee),
        is_checked_in:    state?.is_checked_in ?? false,
        last_check_in_at:  state?.last_check_in_at ?? null,
        last_check_out_at: state?.last_check_out_at ?? null,
        last_latitude:     state?.last_latitude ?? null,
        last_longitude:    state?.last_longitude ?? null,
        last_location_at:  state?.last_location_at ?? null,
      };
    });

    return { data: enriched, total: count ?? 0, source: "snapshot" as const };
  },
};

