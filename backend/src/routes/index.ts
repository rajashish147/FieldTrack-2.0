import type { FastifyInstance } from "fastify";
import { healthRoutes } from "./health.js";
import { internalRoutes } from "./internal.js";
import { attendanceRoutes } from "../modules/attendance/attendance.routes.js";
import { locationsRoutes } from "../modules/locations/locations.routes.js";
import { expensesRoutes } from "../modules/expenses/expenses.routes.js";
import { analyticsRoutes } from "../modules/analytics/analytics.routes.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);
  await app.register(internalRoutes);
  await app.register(attendanceRoutes);
  await app.register(locationsRoutes);
  await app.register(expensesRoutes);
  await app.register(analyticsRoutes);
}
