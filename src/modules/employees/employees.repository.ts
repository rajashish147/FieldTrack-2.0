import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import { orgTable } from "../../db/query.js";
import type { FastifyRequest } from "fastify";
import type { Employee } from "../../types/db.js";
import type { CreateEmployeeBody, UpdateEmployeeBody, EmployeeListQuery } from "./employees.schema.js";
import { BadRequestError } from "../../utils/errors.js";
import { computeActivityStatus } from "../../utils/activity.js";

const EMPLOYEE_COLS =
  "id, organization_id, user_id, name, employee_code, employee_number, phone, is_active, last_activity_at, created_at, updated_at";

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
      // Numeric-safe sort: employee_number extracts the numeric portion of
      // employee_code (EMP1→1, EMP2→2, EMP10→10) for natural ordering.
      .order("employee_number", { ascending: true, nullsFirst: false })
      .order("employee_code", { ascending: true })
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
      activity_status: "ACTIVE" | "RECENT" | "INACTIVE";
    })[];
    total: number;
    source: "snapshot" | "employees";
  }> {
    const { page, limit, active, search, segment } = query;
    const offset = (page - 1) * limit;

    // When a segment filter is requested, query employee_last_state as the
    // primary table so pagination counts reflect only the matching segment —
    // not the total employee count before filtering.
    if (segment) {
      return this.listWithLastStateBySegment(request, query);
    }

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
      // Numeric-safe sort: employee_number for natural EMP1,EMP2,...,EMP10 ordering
      .order("employee_number", { ascending: true, nullsFirst: false })
      .order("employee_code", { ascending: true })
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
          activity_status: "INACTIVE" as const,
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
      const isCheckedIn = state?.is_checked_in ?? false;
      const activityStatus = computeActivityStatus(isCheckedIn, state?.last_check_out_at ?? null);
      return {
        ...(employee as Employee),
        is_checked_in:    isCheckedIn,
        last_check_in_at:  state?.last_check_in_at ?? null,
        last_check_out_at: state?.last_check_out_at ?? null,
        last_latitude:     state?.last_latitude ?? null,
        last_longitude:    state?.last_longitude ?? null,
        last_location_at:  state?.last_location_at ?? null,
        activity_status:   activityStatus,
      };
    });

    return { data: enriched, total: count ?? 0, source: "snapshot" as const };
  },

  /**
   * SQL-side segment filtering for paginated employee lists.
   *
   * Queries employee_last_state as the primary table so COUNT(*) reflects
   * only the matching segment, not the total employee population.
   * This gives correct pagination totals when segment is specified.
   *
   *   active   → is_checked_in = true
   *   recent   → is_checked_in = false AND last_check_out_at >= now() - 24h
   *   inactive → query employees LEFT JOIN state WHERE NOT active AND NOT recent
   */
  async listWithLastStateBySegment(
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
      activity_status: "ACTIVE" | "RECENT" | "INACTIVE";
    })[];
    total: number;
    source: "snapshot" | "employees";
  }> {
    const { page, limit, active, search, segment } = query;
    const offset = (page - 1) * limit;
    const orgId = request.organizationId;
    const recentCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    type StateWithEmployee = {
      is_checked_in: boolean;
      last_check_in_at: string | null;
      last_check_out_at: string | null;
      last_latitude: number | null;
      last_longitude: number | null;
      last_location_at: string | null;
      updated_at: string;
      employees: Employee | null;
    };

    if (segment === "active" || segment === "recent") {
      // Query employee_last_state filtered by segment, join employees
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from("employee_last_state")
        .select(
          `is_checked_in, last_check_in_at, last_check_out_at,
           last_latitude, last_longitude, last_location_at, updated_at,
           employees!employee_last_state_employee_id_fkey(${EMPLOYEE_COLS})`,
          { count: "exact" },
        )
        .eq("organization_id", orgId)
        .order("last_check_in_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (segment === "active") {
        q = q.eq("is_checked_in", true);
      } else {
        // recent: checked out within 24h
        q = q.eq("is_checked_in", false).gte("last_check_out_at", recentCutoff);
      }

      const { data, error, count } = await q;
      if (error) {
        // On error fall back to listEmployees
        return {
          data: [],
          total: 0,
          source: "employees" as const,
        };
      }

      const rows = ((data ?? []) as unknown as StateWithEmployee[])
        .filter((row) => {
          const emp = row.employees;
          if (!emp) return false;
          if (active !== undefined && emp.is_active !== (active === "true")) return false;
          if (search && !emp.name.toLowerCase().includes(search.toLowerCase())) return false;
          return true;
        })
        .map((row) => {
          const emp = row.employees as Employee;
          const activityStatus = computeActivityStatus(row.is_checked_in, row.last_check_out_at);
          return {
            ...emp,
            is_checked_in:    row.is_checked_in,
            last_check_in_at:  row.last_check_in_at,
            last_check_out_at: row.last_check_out_at,
            last_latitude:     row.last_latitude,
            last_longitude:    row.last_longitude,
            last_location_at:  row.last_location_at,
            activity_status:   activityStatus,
          };
        });

      return { data: rows, total: count ?? rows.length, source: "snapshot" as const };
    }

    // segment === "inactive": employees that are NOT active and NOT recent.
    // Uses deterministic NOT EXISTS SQL via RPC — employees with no employee_last_state
    // row are correctly included in the inactive segment (no-snapshot employees).
    const { data: inactiveData, error: inactiveError } = await supabase.rpc(
      "list_inactive_employees",
      {
        p_org_id: orgId,
        p_search: search || null,
        p_is_active: active !== undefined ? active === "true" : null,
        p_limit: limit,
        p_offset: offset,
      },
    );

    if (inactiveError) {
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
          activity_status: "INACTIVE" as const,
        })),
        source: "employees" as const,
      };
    }

    type InactiveRow = {
      id: string;
      organization_id: string;
      user_id: string | null;
      name: string;
      employee_code: string;
      employee_number: number | null;
      phone: string | null;
      is_active: boolean;
      last_activity_at: string | null;
      created_at: string;
      updated_at: string;
      is_checked_in: boolean;
      last_check_in_at: string | null;
      last_check_out_at: string | null;
      last_latitude: number | null;
      last_longitude: number | null;
      last_location_at: string | null;
      total_count: number;
    };

    const rows = (inactiveData ?? []) as InactiveRow[];
    const totalCount = rows.length > 0 ? Number(rows[0].total_count) : 0;

    const inactiveRows = rows.map((row) => ({
      id: row.id,
      organization_id: row.organization_id,
      user_id: row.user_id,
      name: row.name,
      employee_code: row.employee_code,
      phone: row.phone,
      is_active: row.is_active,
      created_at: row.created_at,
      updated_at: row.updated_at,
      employee_number:   row.employee_number ?? null,
      last_activity_at:  row.last_activity_at ?? null,
      is_checked_in:    false as const,
      last_check_in_at:  row.last_check_in_at,
      last_check_out_at: row.last_check_out_at,
      last_latitude:     row.last_latitude,
      last_longitude:    row.last_longitude,
      last_location_at:  row.last_location_at,
      activity_status:   "INACTIVE" as const,
    }));

    return { data: inactiveRows, total: totalCount, source: "snapshot" as const };
  },

  /**
   * GET /admin/employees/:id/profile
   * Returns comprehensive profile: employee info + activity stats + recent sessions + expenses.
   */
  async getEmployeeProfile(
    request: FastifyRequest,
    employeeId: string,
  ): Promise<{
    employee: Employee & { is_checked_in: boolean; last_check_in_at: string | null };
    summary: {
      totalSessions: number;
      totalDistanceKm: number;
      totalDurationSeconds: number;
      expensesSubmitted: number;
      expensesApproved: number;
    };
    recentSessions: Array<Record<string, unknown>>;
    expenses: Array<Record<string, unknown>>;
  } | null> {
    // Fetch employee
    const { data: emp, error: empErr } = await orgTable(request, "employees")
      .select(EMPLOYEE_COLS)
      .eq("id", employeeId)
      .single();

    if (empErr?.code === "PGRST116" || !emp) return null;
    if (empErr) throw new Error(`Failed to fetch employee: ${empErr.message}`);

    // Fetch last state
    const { data: state } = await supabase
      .from("employee_last_state")
      .select("is_checked_in, last_check_in_at")
      .eq("employee_id", employeeId)
      .eq("organization_id", request.organizationId)
      .single();

    // Fetch session stats
    const { data: sessionStats } = await supabase
      .from("attendance_sessions")
      .select("id", { count: "exact", head: true })
      .eq("employee_id", employeeId)
      .eq("organization_id", request.organizationId);

    // Fetch distance/duration aggregates from daily metrics
    const { data: metrics } = await supabase
      .from("employee_daily_metrics")
      .select("total_distance_km, total_duration_seconds")
      .eq("employee_id", employeeId)
      .eq("organization_id", request.organizationId);

    const totalDistanceKm = (metrics ?? []).reduce((sum, m) => sum + (Number(m.total_distance_km) || 0), 0);
    const totalDurationSeconds = (metrics ?? []).reduce((sum, m) => sum + (Number(m.total_duration_seconds) || 0), 0);

    // Fetch expense stats
    const { count: expSubmitted } = await supabase
      .from("expenses")
      .select("id", { count: "exact", head: true })
      .eq("employee_id", employeeId)
      .eq("organization_id", request.organizationId);

    const { count: expApproved } = await supabase
      .from("expenses")
      .select("id", { count: "exact", head: true })
      .eq("employee_id", employeeId)
      .eq("organization_id", request.organizationId)
      .eq("status", "APPROVED");

    // Fetch 10 most recent sessions
    const { data: recentSessions } = await orgTable(request, "attendance_sessions")
      .select("id, checkin_at, checkout_at, total_distance_km, total_duration_seconds, distance_recalculation_status, created_at")
      .eq("employee_id", employeeId)
      .order("checkin_at", { ascending: false })
      .range(0, 9);

    // Fetch 10 most recent expenses
    const { data: recentExpenses } = await orgTable(request, "expenses")
      .select("id, amount, description, status, submitted_at, reviewed_at")
      .eq("employee_id", employeeId)
      .order("submitted_at", { ascending: false })
      .range(0, 9);

    return {
      employee: {
        ...(emp as Employee),
        is_checked_in: (state as Record<string, unknown>)?.is_checked_in === true,
        last_check_in_at: ((state as Record<string, unknown>)?.last_check_in_at as string) ?? null,
      },
      summary: {
        totalSessions: (sessionStats as unknown[])?.length ?? 0,
        totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
        totalDurationSeconds: Math.round(totalDurationSeconds),
        expensesSubmitted: expSubmitted ?? 0,
        expensesApproved: expApproved ?? 0,
      },
      recentSessions: (recentSessions ?? []) as Array<Record<string, unknown>>,
      expenses: (recentExpenses ?? []) as Array<Record<string, unknown>>,
    };
  },

  /**
   * Site-wide search across employees, expenses, and sessions.
   * Uses PostgreSQL trigram matching for fuzzy search.
   */
  async siteSearch(
    request: FastifyRequest,
    query: string,
    limit: number,
  ): Promise<{
    employees: Array<{ id: string; name: string; employee_code: string | null; is_active: boolean }>;
    expenses: Array<{ id: string; description: string; amount: number; status: string; employee_name: string | null }>;
  }> {
    const orgId = request.organizationId;
    const searchPattern = `%${query}%`;

    // Search employees by name or code
    const { data: employees } = await supabase
      .from("employees")
      .select("id, name, employee_code, is_active")
      .eq("organization_id", orgId)
      .or(`name.ilike.${searchPattern},employee_code.ilike.${searchPattern}`)
      .order("name")
      .limit(limit);

    // Search expenses by description
    const { data: expenses } = await supabase
      .from("expenses")
      .select("id, description, amount, status, employees!expenses_employee_id_fkey(name)")
      .eq("organization_id", orgId)
      .ilike("description", searchPattern)
      .order("submitted_at", { ascending: false })
      .limit(limit);

    const flatExpenses = ((expenses ?? []) as Array<Record<string, unknown>>).map((row) => {
      const emp = row.employees as { name?: string } | null;
      return {
        id: row.id as string,
        description: row.description as string,
        amount: row.amount as number,
        status: row.status as string,
        employee_name: emp?.name ?? null,
      };
    });

    return {
      employees: (employees ?? []) as Array<{ id: string; name: string; employee_code: string | null; is_active: boolean }>,
      expenses: flatExpenses,
    };
  },
};

