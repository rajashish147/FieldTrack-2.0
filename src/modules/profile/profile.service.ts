import type { FastifyRequest } from "fastify";
import { profileRepository, computeActivityStatusFromTimestamp } from "./profile.repository.js";
import { NotFoundError, ForbiddenError } from "../../utils/errors.js";
import type { EmployeeProfileData } from "../../types/shared.js";

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

    // feat-1: attempt single-row snapshot read first (O(1) PK lookup).
    // Falls back to daily_metrics scan when snapshot hasn't been seeded yet.
    const t0 = Date.now();
    const snapshot = await profileRepository.getMetricsSnapshot(
      employeeId,
      request.organizationId,
    );
    const snapshotMs = Date.now() - t0;

    let stats: {
      totalSessions: number;
      totalDistanceKm: number;
      totalDurationSeconds: number;
      expensesSubmitted: number;
      expensesApproved: number;
    };

    if (snapshot) {
      // Snapshot hit: all totals from one PK lookup — typically <5 ms.
      if (snapshotMs > 50) {
        request.log.warn(
          { employeeId, snapshotMs, route: "profile" },
          "feat-1: slow snapshot read — expected <50ms",
        );
      }
      const expenseStats = await profileRepository.getEmployeeExpenseStats(request, employeeId);
      stats = {
        totalSessions:        snapshot.totalSessions,
        totalDistanceKm:      snapshot.totalDistanceKm,
        totalDurationSeconds: snapshot.totalDurationSeconds,
        expensesSubmitted:    expenseStats.expensesSubmitted,
        expensesApproved:     expenseStats.expensesApproved,
      };
    } else {
      // Snapshot miss (first run / not yet seeded): fall back to legacy aggregation.
      request.log.info({ employeeId }, "feat-1: snapshot miss — falling back to daily_metrics");
      const [legacyStats, expenseStats] = await Promise.all([
        profileRepository.getEmployeeStats(request, employeeId),
        profileRepository.getEmployeeExpenseStats(request, employeeId),
      ]);
      stats = {
        totalSessions:        legacyStats.totalSessions,
        totalDistanceKm:      legacyStats.totalDistanceKm,
        totalDurationSeconds: legacyStats.totalDurationSeconds,
        expensesSubmitted:    expenseStats.expensesSubmitted,
        expensesApproved:     expenseStats.expensesApproved,
      };
    }

    request.log.info(
      {
        employeeId,
        snapshotMs,
        totalMs:   Date.now() - t0,
        source:    snapshot ? "snapshot" : "daily_metrics",
        route:     "feat1:profile",
      },
      "feat1:profile query",
    );

    return {
      id: employee.id,
      name: employee.name,
      employee_code: employee.employee_code,
      phone: employee.phone,
      is_active: employee.is_active,
      activityStatus: computeActivityStatusFromTimestamp(employee.last_activity_at),
      last_activity_at: employee.last_activity_at,
      created_at: employee.created_at,
      stats,
    };
  },
};
