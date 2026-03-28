import type { FastifyInstance } from "fastify";
import { healthRoutes } from "./health.js";
import { internalRoutes } from "./internal.js";
import { debugRoutes } from "./debug.js";
import { attendanceRoutes } from "../modules/attendance/attendance.routes.js";
import { locationsRoutes } from "../modules/locations/locations.routes.js";
import { expensesRoutes } from "../modules/expenses/expenses.routes.js";
import { analyticsRoutes } from "../modules/analytics/analytics.routes.js";
import { monitoringRoutes } from "../modules/admin/monitoring.routes.js";
import { adminSessionsRoutes } from "../modules/admin/sessions.routes.js";
import { employeesRoutes } from "../modules/employees/employees.routes.js";
import { dashboardRoutes } from "../modules/dashboard/dashboard.routes.js";
import { profileRoutes } from "../modules/profile/profile.routes.js";
import { adminDashboardRoutes } from "../modules/admin/dashboard.routes.js";
import { adminMapRoutes } from "../modules/admin/map.routes.js";
import { webhookDlqRoutes } from "../modules/admin/webhook-dlq.routes.js";
import { eventsRoutes } from "./events.routes.js";
import { webhooksRoutes } from "../modules/webhooks/webhooks.routes.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);
  await app.register(internalRoutes);
  await app.register(debugRoutes);
  await app.register(attendanceRoutes);
  await app.register(locationsRoutes);
  await app.register(expensesRoutes);
  await app.register(analyticsRoutes);
  await app.register(monitoringRoutes);
  await app.register(adminSessionsRoutes);
  await app.register(employeesRoutes);
  await app.register(dashboardRoutes);
  await app.register(profileRoutes);
  await app.register(adminDashboardRoutes);
  await app.register(adminMapRoutes);
  await app.register(webhookDlqRoutes);
  await app.register(eventsRoutes);
  await app.register(webhooksRoutes);
}
