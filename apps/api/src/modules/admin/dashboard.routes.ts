import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import { ok, handleError } from "../../utils/response.js";
import { expensesRepository } from "../expenses/expenses.repository.js";
import type { AdminDashboardData } from "@fieldtrack/types";

// ─── Response schema ─────────────────────────────────────────────────────────

const adminDashboardResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    activeEmployeeCount: z.number(),
    recentEmployeeCount: z.number(),
    inactiveEmployeeCount: z.number(),
    todaySessionCount: z.number(),
    todayDistanceKm: z.number(),
    pendingExpenseCount: z.number(),
    pendingExpenseAmount: z.number(),
  }),
});

// ─── Route registration ───────────────────────────────────────────────────────

/**
 * GET /admin/dashboard
 *
 * Single aggregation endpoint that collapses what previously required 4-5
 * separate frontend calls into one round-trip.
 *
 * Data sources:
 *  - employee_latest_sessions  → status counts (O(employees), snapshot table)
 *  - attendance_sessions       → today's session + distance totals (date-scoped)
 *  - expenses                  → pending count + amount (org-scoped)
 *
 * All three queries run in parallel via Promise.all.
 */
export async function adminDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/admin/dashboard",
    {
      schema: {
        tags: ["admin"],
        response: {
          200: adminDashboardResponseSchema.describe("Admin dashboard aggregation"),
        },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const orgId = request.organizationId;
        const todayStart = new Date();
        todayStart.setUTCHours(0, 0, 0, 0);
        const todayStartISO = todayStart.toISOString();

        const [snapshotResult, todayResult, expenseSummary] = await Promise.all([
          // Activity status counts from snapshot table (O(employees))
          supabase
            .from("employee_latest_sessions")
            .select("status", { count: "exact" })
            .eq("organization_id", orgId),

          // Today's sessions — only date-filtered rows, uses checkin_at index
          supabase
            .from("attendance_sessions")
            .select("id, total_distance_km")
            .eq("organization_id", orgId)
            .gte("checkin_at", todayStartISO),

          // Pending expenses summary
          expensesRepository.findExpenseSummaryByEmployee(request, 1, 5000),
        ]);

        if (snapshotResult.error) {
          throw new Error(`Dashboard: snapshot query failed: ${snapshotResult.error.message}`);
        }
        if (todayResult.error) {
          throw new Error(`Dashboard: today sessions query failed: ${todayResult.error.message}`);
        }

        // Count by status
        let activeEmployeeCount = 0;
        let recentEmployeeCount = 0;
        let inactiveEmployeeCount = 0;
        for (const row of (snapshotResult.data ?? []) as Array<{ status: string }>) {
          if (row.status === "ACTIVE") activeEmployeeCount++;
          else if (row.status === "RECENT") recentEmployeeCount++;
          else inactiveEmployeeCount++;
        }

        // Today's aggregates
        const todaySessions = (todayResult.data ?? []) as Array<{ id: string; total_distance_km: number | null }>;
        const todaySessionCount = todaySessions.length;
        const todayDistanceKm = Math.round(
          todaySessions.reduce((sum, s) => sum + (s.total_distance_km ?? 0), 0) * 100,
        ) / 100;

        // Pending expense totals
        let pendingExpenseCount = 0;
        let pendingExpenseAmount = 0;
        for (const emp of expenseSummary.data) {
          pendingExpenseCount += emp.pendingCount;
          pendingExpenseAmount += emp.pendingAmount;
        }
        pendingExpenseAmount = Math.round(pendingExpenseAmount * 100) / 100;

        const result: AdminDashboardData = {
          activeEmployeeCount,
          recentEmployeeCount,
          inactiveEmployeeCount,
          todaySessionCount,
          todayDistanceKm,
          pendingExpenseCount,
          pendingExpenseAmount,
        };

        reply.status(200).send(ok(result));
      } catch (error) {
        handleError(error, request, reply, "Unexpected error fetching admin dashboard");
      }
    },
  );
}
