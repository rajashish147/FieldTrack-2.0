import type { FastifyRequest } from "fastify";
import { profileRepository, computeActivityStatusFromTimestamp } from "./profile.repository.js";
import { NotFoundError, ForbiddenError } from "../../utils/errors.js";
import type { EmployeeProfileData } from "@fieldtrack/types";

export const profileService = {
  /**
   * Get the requesting employee's own profile.
   * Requires an employee context (request.employeeId).
   */
  async getMyProfile(request: FastifyRequest): Promise<EmployeeProfileData> {
    const employeeId = request.employeeId;
    if (!employeeId) {
      throw new ForbiddenError("No employee profile linked to this account");
    }

    return this.getEmployeeProfile(request, employeeId);
  },

  /**
   * Get any employee profile (admin access).
   * The employee must belong to the admin's organization.
   */
  async getEmployeeProfile(
    request: FastifyRequest,
    employeeId: string,
  ): Promise<EmployeeProfileData> {
    const employee = await profileRepository.getEmployeeById(request, employeeId);
    if (!employee) {
      throw new NotFoundError("Employee not found");
    }

    const [stats, expenseStats] = await Promise.all([
      profileRepository.getEmployeeStats(request, employeeId),
      profileRepository.getEmployeeExpenseStats(request, employeeId),
    ]);

    return {
      id: employee.id,
      name: employee.name,
      employee_code: employee.employee_code,
      phone: employee.phone,
      is_active: employee.is_active,
      activityStatus: computeActivityStatusFromTimestamp(employee.last_activity_at),
      last_activity_at: employee.last_activity_at,
      created_at: employee.created_at,
      stats: {
        totalSessions: stats.totalSessions,
        totalDistanceKm: stats.totalDistanceKm,
        totalDurationSeconds: stats.totalDurationSeconds,
        expensesSubmitted: expenseStats.expensesSubmitted,
        expensesApproved: expenseStats.expensesApproved,
      },
    };
  },
};
