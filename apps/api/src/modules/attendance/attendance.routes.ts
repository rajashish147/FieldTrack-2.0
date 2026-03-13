import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AttendanceSession } from "@fieldtrack/types";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { attendanceController } from "./attendance.controller.js";
import { sessionSummaryController } from "../session_summary/session_summary.controller.js";
import { paginationSchema } from "./attendance.schema.js";

const sessionItemSchema: z.ZodType<AttendanceSession> = z.object({
  id: z.string(),
  employee_id: z.string(),
  organization_id: z.string(),
  checkin_at: z.string(),
  checkout_at: z.string().nullable(),
  distance_recalculation_status: z.string(),
  total_distance_km: z.number().nullable(),
  total_duration_seconds: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  // Enriched fields — present on list queries, optional on single-session responses
  employee_code: z.string().nullable().optional(),
  employee_name: z.string().nullable().optional(),
  activityStatus: z.enum(["ACTIVE", "RECENT", "INACTIVE"]).optional(),
});

const paginationMetaSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
});

const singleObjectResponseSchema = z.object({
  success: z.literal(true),
  data: sessionItemSchema,
});

const sessionListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(sessionItemSchema),
  pagination: paginationMetaSchema,
});

/**
 * Attendance routes — all endpoints require authentication.
 * ADMIN-only routes use the requireRole middleware.
 */
export async function attendanceRoutes(app: FastifyInstance): Promise<void> {
  // Check in — any authenticated user
  app.post(
    "/attendance/check-in",
    {
      schema: { tags: ["attendance"], response: { 201: singleObjectResponseSchema.describe("Session check-in record") } },
      preValidation: [authenticate],
    },
    attendanceController.checkIn,
  );

  // Check out — any authenticated user
  app.post(
    "/attendance/check-out",
    {
      schema: { tags: ["attendance"], response: { 200: singleObjectResponseSchema.describe("Session check-out record") } },
      preValidation: [authenticate],
    },
    attendanceController.checkOut,
  );

  // Recalculate distance and duration explicitly.
  // Rate-limited per IP to prevent recalculation flooding.
  app.post<{ Params: { sessionId: string } }>(
    "/attendance/:sessionId/recalculate",
    {
      schema: { tags: ["attendance"], response: { 200: singleObjectResponseSchema.describe("Recalculated session record") } },
      config: {
        rateLimit: {
          max: 5,
          timeWindow: 60_000,
          keyGenerator: (req: FastifyRequest): string => req.user?.sub ?? req.ip,
        },
      },
      preValidation: [authenticate],
    },
    sessionSummaryController.recalculate,
  );

  // My sessions — employee's own sessions
  app.get(
    "/attendance/my-sessions",
    {
      schema: {
        tags: ["attendance"],
        querystring: paginationSchema,
        response: { 200: sessionListResponseSchema.describe("Employee's own attendance sessions") },
      },
      // preValidation ensures 401 fires before querystring validation
      preValidation: [authenticate],
    },
    attendanceController.getMySessions,
  );

  // Org sessions — ADMIN only
  app.get(
    "/attendance/org-sessions",
    {
      schema: {
        tags: ["admin"],
        querystring: paginationSchema,
        response: { 200: sessionListResponseSchema.describe("All organization attendance sessions") },
      },
      // preValidation ensures 401/403 fires before querystring validation
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    attendanceController.getOrgSessions,
  );
}
