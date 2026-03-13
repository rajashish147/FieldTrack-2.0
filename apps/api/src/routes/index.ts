import type { FastifyInstance } from "fastify";
import { healthRoutes } from "./health.js";
import { internalRoutes } from "./internal.js";
import { debugRoutes } from "./debug.js";
import { attendanceRoutes } from "../modules/attendance/attendance.routes.js";
import { locationsRoutes } from "../modules/locations/locations.routes.js";
import { expensesRoutes } from "../modules/expenses/expenses.routes.js";
import { analyticsRoutes } from "../modules/analytics/analytics.routes.js";
import { monitoringRoutes } from "../modules/admin/monitoring.routes.js";
import { employeesRoutes } from "../modules/employees/employees.routes.js";
import { dashboardRoutes } from "../modules/dashboard/dashboard.routes.js";
import { profileRoutes } from "../modules/profile/profile.routes.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);
  await app.register(internalRoutes);
  await app.register(debugRoutes);
  await app.register(attendanceRoutes);
  await app.register(locationsRoutes);
  await app.register(expensesRoutes);
  await app.register(analyticsRoutes);
  await app.register(monitoringRoutes);
  await app.register(employeesRoutes);
  await app.register(dashboardRoutes);
  await app.register(profileRoutes);
}
