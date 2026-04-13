import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import { ok, handleError } from "../../utils/response.js";
import { analyticsService } from "../analytics/analytics.service.js";
import { getCached } from "../../utils/cache.js";
import type { AdminDashboardData } from "../../types/shared.js";

// Phase 24: Simplified TTL — the snapshot is always current within a worker
// cycle (~seconds), so Redis just absorbs repeated polling load.
const DASHBOARD_CACHE_TTL = 60;

// Shape of a row returned from org_dashboard_snapshot.
interface DashboardSnapshot {
  active_employee_count: number;
  recent_employee_count: number;
  inactive_employee_count: number;
  active_employees_today: number;
  today_session_count: number;
  today_distance_km: number;
  pending_expense_count: number;
  pending_expense_amount: number;
  updated_at: string;
}

// ─── Route registration ───────────────────────────────────────────────────────

/**
 * GET /admin/dashboard
 *
 * Phase 24 (revised): three independent Redis-cached calls in parallel.
 *
 * Hot path (all caches warm): 3 × ~2ms Redis GETs  → assembled in < 10 ms.
 *
 * Cold path per component:
 *   snapshot  (60 s TTL)  → ONE indexed PK lookup on org_dashboard_snapshot
 *   sessionTrend (5 min)  → org_daily_metrics query (analyticsService)
 *   leaderboard  (5 min)  → employee_daily_metrics query (analyticsService)
 *
 * Running them in parallel means a full cold start completes in max(each cold
 * path) ≈ 200 ms rather than 200 + 200 + 400 ms = 800 ms sequentially.
 *
 * Cache invalidation: invalidateOrgAnalytics() clears all three keys when the
 * analytics worker completes after a session checkout.
 */
export async function adminDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/admin/dashboard",
    {
      schema: {
        tags: ["admin"],
        summary: "Admin dashboard overview",
        description:
          "Returns org-wide KPIs, 7-day session trend, and 30-day distance leaderboard in one call. " +
          "Served from Redis cache (60 s TTL for snapshot, 5 min for trend/leaderboard).",
        response: {
          200: z.object({
            success: z.literal(true),
            data: z.object({
              activeEmployeeCount:   z.number().int().describe("Employees with ACTIVE status"),
              recentEmployeeCount:   z.number().int().describe("Employees with RECENT status"),
              inactiveEmployeeCount: z.number().int().describe("Employees with INACTIVE status"),
              activeEmployeesToday:  z.number().int().describe("Unique employees who checked in today"),
              todaySessionCount:     z.number().int().describe("Sessions started today"),
              todayDistanceKm:       z.number().describe("Total km tracked today"),
              pendingExpenseCount:   z.number().int().describe("Expenses awaiting review"),
              pendingExpenseAmount:  z.number().describe("Total pending expense amount"),
              snapshotUpdatedAt:     z.string().nullable().describe("When the snapshot was last refreshed"),
              sessionTrend: z.array(z.object({
                date: z.string(),
                session_count: z.number(),
                unique_employees: z.number(),
                total_distance_km: z.number(),
              })).describe("Daily session counts for the last 7 days"),
              leaderboard: z.array(z.object({
                employee_id: z.string(),
                employee_name: z.string(),
                employee_code: z.string().nullable(),
                total_distance_km: z.number(),
                session_count: z.number(),
              })).describe("Top 5 employees by distance in the last 30 days"),
            }),
          }).describe("Admin dashboard KPIs"),
        },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const orgId = request.organizationId;
        const todayDateStr = new Date().toISOString().substring(0, 10);
        const sevenDaysAgo = new Date(`${todayDateStr}T00:00:00Z`);
        sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
        const thirtyDaysAgo = new Date(`${todayDateStr}T00:00:00Z`);
        thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);

        // All three run in parallel — each has its own Redis cache so a miss
        // on one does not stall the others.
        const [snap, sessionTrend, leaderboard] = await Promise.all([
          // 1. Snapshot: single PK lookup, 60-second TTL.
          getCached<DashboardSnapshot | null>(
            `org:${orgId}:dashboard:snap`,
            DASHBOARD_CACHE_TTL,
            async () => {
              const { data, error } = await supabase
                .from("org_dashboard_snapshot")
                .select(
                  "active_employee_count, recent_employee_count, inactive_employee_count, " +
                  "active_employees_today, today_session_count, today_distance_km, " +
                  "pending_expense_count, pending_expense_amount, updated_at",
                )
                .eq("organization_id", orgId)
                .maybeSingle();

              if (error) {
                throw new Error(
                  `Dashboard: snapshot query failed: ${error.message}`,
                );
              }
              return data as DashboardSnapshot | null;
            },
          ),
          // 2 & 3. Analytics — each has its own 5-min Redis cache inside the service.
          analyticsService.getSessionTrend(
            request,
            sevenDaysAgo.toISOString(),
            undefined,
          ),
          analyticsService.getLeaderboard(
            request,
            "distance",
            thirtyDaysAgo.toISOString(),
            undefined,
            5,
          ),
        ]);

        const result: AdminDashboardData = {
          activeEmployeeCount:    snap?.active_employee_count    ?? 0,
          recentEmployeeCount:    snap?.recent_employee_count    ?? 0,
          inactiveEmployeeCount:  snap?.inactive_employee_count  ?? 0,
          activeEmployeesToday:   snap?.active_employees_today   ?? 0,
          todaySessionCount:      snap?.today_session_count      ?? 0,
          todayDistanceKm:        snap?.today_distance_km        ?? 0,
          pendingExpenseCount:    snap?.pending_expense_count    ?? 0,
          pendingExpenseAmount:   Number(snap?.pending_expense_amount ?? 0),
          snapshotUpdatedAt:      snap?.updated_at ?? null,
          sessionTrend,
          leaderboard,
        };

        reply.status(200).send(ok(result));
      } catch (error) {
        handleError(error, request, reply, "Unexpected error fetching admin dashboard");
      }
    },
  );
}
