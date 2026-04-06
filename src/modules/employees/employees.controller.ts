import type { FastifyRequest, FastifyReply } from "fastify";
import { employeesRepository } from "./employees.repository.js";
import {
  createEmployeeBodySchema,
  updateEmployeeBodySchema,
  employeeListQuerySchema,
} from "./employees.schema.js";
import { ok, fail, paginated, handleError } from "../../utils/response.js";
import { NotFoundError } from "../../utils/errors.js";
import { emitEvent } from "../../utils/event-bus.js";
import { supabaseServiceClient } from "../../config/supabase.js";
import { attendanceRepository } from "../attendance/attendance.repository.js";

export const employeesController = {
  /**
   * POST /admin/employees
   * Create a new employee. employee_code is auto-generated when omitted.
   */
  async create(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = createEmployeeBodySchema.parse(request.body);
      const employee = await employeesRepository.createEmployee(request, body);

      request.log.info(
        {
          event: "employee_created",
          employeeId: employee.id,
          employeeCode: employee.employee_code,
          organizationId: request.organizationId,
          createdBy: request.user.sub,
        },
        "Employee created",
      );

      emitEvent("employee.created", {
        organization_id: request.organizationId,
        data: {
          employee_id:   employee.id,
          employee_code: employee.employee_code,
          name:          employee.name,
          created_at:    employee.created_at,
        },
      });

      reply.status(201).send(ok(employee));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error creating employee");
    }
  },

  /**
   * GET /admin/employees
   * Paginated list of employees in the org with optional name search.
   * feat-1: enriched with real-time check-in state from employee_last_state snapshot.
   */
  async list(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const query = employeeListQuerySchema.parse(request.query);
      const t0 = Date.now();
      const result = await employeesRepository.listWithLastState(request, query);
      const durationMs = Date.now() - t0;
      request.log.info(
        { route: "/admin/employees", durationMs, source: result.source, total: result.total },
        "feat1:admin-employees query",
      );
      if (durationMs > 50) {
        request.log.warn(
          { route: "/admin/employees", durationMs },
          "feat1: slow snapshot read — expected <50ms",
        );
      }
      reply.status(200).send(paginated(result.data, query.page, query.limit, result.total));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error listing employees");
    }
  },

  /**
   * GET /admin/employees/:id
   * Fetch a single employee record.
   */
  async getOne(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const { id } = request.params;
      const employee = await employeesRepository.findById(request, id);
      if (!employee) {
        reply.status(404).send(fail("Employee not found", request.id));
        return;
      }
      reply.status(200).send(ok(employee));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error fetching employee");
    }
  },

  /**
   * PATCH /admin/employees/:id
   * Update name and/or phone for an employee.
   */
  async update(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const { id } = request.params;
      const body = updateEmployeeBodySchema.parse(request.body);

      const existing = await employeesRepository.findById(request, id);
      if (!existing) throw new NotFoundError("Employee not found");

      const employee = await employeesRepository.updateEmployee(request, id, body);
      reply.status(200).send(ok(employee));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error updating employee");
    }
  },

  /**
   * PATCH /admin/employees/:id/status
   * Activate or deactivate an employee.
   */
  async setStatus(
    request: FastifyRequest<{ Params: { id: string }; Body: { is_active: boolean } }>,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const { id } = request.params;
      const body = request.body as { is_active: boolean };

      if (typeof body.is_active !== "boolean") {
        reply.status(400).send(fail("is_active must be a boolean", request.id));
        return;
      }

      const existing = await employeesRepository.findById(request, id);
      if (!existing) throw new NotFoundError("Employee not found");

      const employee = await employeesRepository.setActiveStatus(request, id, body.is_active);

      // On deactivation: close any active attendance session and ban the auth user
      // so the employee cannot log in again until re-activated.
      if (!body.is_active && existing.user_id) {
        // Close active session (fire-and-forget — best effort)
        attendanceRepository.findOpenSession(request, id)
          .then(async (session) => {
            if (session) {
              await attendanceRepository.closeSession(request, session.id);
              request.log.info({ sessionId: session.id, employeeId: id }, "Auto-closed session on deactivation");
            }
          })
          .catch((err: unknown) => {
            request.log.warn({ employeeId: id, error: err instanceof Error ? err.message : String(err) }, "Failed to auto-close session on deactivation");
          });

        // Ban auth user so they cannot log in
        supabaseServiceClient.auth.admin.updateUserById(existing.user_id, { ban_duration: "876000h" })
          .then(({ error }) => {
            if (error) {
              request.log.warn({ userId: existing.user_id, error: error.message }, "Failed to ban auth user on deactivation");
            } else {
              request.log.info({ userId: existing.user_id, employeeId: id }, "Auth user banned on deactivation");
            }
          })
          .catch((err: unknown) => {
            request.log.warn({ userId: existing.user_id, error: err instanceof Error ? err.message : String(err) }, "Failed to ban auth user on deactivation");
          });
      }

      // On re-activation: unban the auth user
      if (body.is_active && existing.user_id) {
        supabaseServiceClient.auth.admin.updateUserById(existing.user_id, { ban_duration: "none" })
          .then(({ error }) => {
            if (error) {
              request.log.warn({ userId: existing.user_id, error: error.message }, "Failed to unban auth user on activation");
            } else {
              request.log.info({ userId: existing.user_id, employeeId: id }, "Auth user unbanned on activation");
            }
          })
          .catch((err: unknown) => {
            request.log.warn({ userId: existing.user_id, error: err instanceof Error ? err.message : String(err) }, "Failed to unban auth user on activation");
          });
      }

      request.log.info(
        {
          event: body.is_active ? "employee_activated" : "employee_deactivated",
          employeeId: id,
          adminId: request.user.sub,
          organizationId: request.organizationId,
        },
        body.is_active ? "Employee activated" : "Employee deactivated",
      );

      reply.status(200).send(ok(employee));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error updating employee status");
    }
  },
};

