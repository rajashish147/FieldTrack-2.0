import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EmployeeProfileData } from "../../types/shared.js";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { profileController } from "./profile.controller.js";

const profileStatsSchema = z.object({
  totalSessions: z.number(),
  totalDistanceKm: z.number(),
  totalDurationSeconds: z.number(),
  expensesSubmitted: z.number(),
  expensesApproved: z.number(),
});

const profileResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    data: z.object({
      id: z.string(),
      name: z.string(),
      employee_code: z.string().nullable(),
      phone: z.string().nullable(),
      is_active: z.boolean(),
      activityStatus: z.enum(["ACTIVE", "RECENT", "INACTIVE"]),
      last_activity_at: z.string().nullable(),
      created_at: z.string(),
      stats: profileStatsSchema,
    }) satisfies z.ZodType<EmployeeProfileData>,
  }),
  z.object({
    success: z.literal(true),
    data: z.null(),
    meta: z.object({ hasProfile: z.literal(false) }),
  }),
]);

/**
 * Profile routes — employee self-profile and admin employee profile lookup.
 */
export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/profile/me",
    {
      schema: {
        tags: ["profile"],
        response: { 200: profileResponseSchema.describe("Employee self profile") },
      },
      preValidation: [authenticate],
    },
    profileController.getMyProfile,
  );

  app.get(
    "/admin/employees/:employeeId/profile",
    {
      schema: {
        tags: ["admin"],
        params: z.object({ employeeId: z.string().uuid() }),
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    profileController.getEmployeeProfile,
  );
}
