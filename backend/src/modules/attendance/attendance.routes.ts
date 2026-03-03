import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { attendanceController } from "./attendance.controller.js";
import { sessionSummaryController } from "../session_summary/session_summary.controller.js";

/**
 * Attendance routes — all endpoints require authentication.
 * ADMIN-only routes use the requireRole middleware.
 */
export async function attendanceRoutes(app: FastifyInstance): Promise<void> {
    // Check in — any authenticated user
    app.post("/attendance/check-in", {
        preHandler: [authenticate],
    }, attendanceController.checkIn);

    // Check out — any authenticated user
    app.post("/attendance/check-out", {
        preHandler: [authenticate],
    }, attendanceController.checkOut);

    // Recalculate distance and duration explicitly — any authenticated user
    app.post<{ Params: { sessionId: string } }>("/attendance/:sessionId/recalculate", {
        preHandler: [authenticate],
    }, sessionSummaryController.recalculate);

    // My sessions — employee's own sessions
    app.get("/attendance/my-sessions", {
        preHandler: [authenticate],
    }, attendanceController.getMySessions);

    // Org sessions — ADMIN only
    app.get("/attendance/org-sessions", {
        preHandler: [authenticate, requireRole("ADMIN")],
    }, attendanceController.getOrgSessions);
}
