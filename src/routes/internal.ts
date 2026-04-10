import type { FastifyInstance } from "fastify";
import { metrics } from "../utils/metrics.js";
import { getQueueDepth } from "../workers/distance.queue.js";
import { authenticate } from "../middleware/auth.js";
import { requireRole } from "../middleware/role-guard.js";

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /internal/metrics
   *
   * Returns a structured JSON snapshot of the process's current operational
   * state. All values are point-in-time readings — no aggregation window.
   *
   * Requires: JWT authentication + ADMIN role.
   *
   * Response shape:
   * {
   *   uptimeSeconds:          number   — seconds since the process started
   *   queueDepth:             number   — sessions currently waiting in the worker queue
   *   totalRecalculations:    number   — cumulative completed distance recalculations
   *   totalLocationsInserted: number   — cumulative GPS points written (deduped)
   *   avgRecalculationMs:     number   — rolling average recalculation latency (last 100 jobs)
   * }
   */
  app.get(
    "/internal/metrics",
    {
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (_request, reply): Promise<void> => {
      const queueDepth = await getQueueDepth();
      const snapshot = metrics.snapshot(queueDepth);
      reply.status(200).send(snapshot);
    },
  );

  /**
   * GET /internal/queues/status
   *
   * Returns detailed queue status including depth, active, and delayed job counts.
   * Exposed only on internal network (no external DNS alias) for operator dashboards.
   *
   * Requires: JWT authentication + ADMIN role. No external exposure.
   *
   * Response shape:
   * {
   *   queues: {
   *     distance: { depth, active, delayed, ...}
   *     analytics: { depth, active, delayed, ... }
   *   }
   * }
   */
  app.get(
    "/internal/queues/status",
    {
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (_request, reply): Promise<void> => {
      try {
        const { distanceQueue } = await import("../workers/distance.queue.js");
        const { analyticsQueue } = await import("../workers/analytics.queue.js");

        const [distanceWaiting, distanceActive, distanceDelayed, analyticsWaiting, analyticsActive, analyticsDelayed] =
          await Promise.all([
            distanceQueue.getWaitingCount(),
            distanceQueue.getActiveCount(),
            distanceQueue.getDelayedCount(),
            analyticsQueue.getWaitingCount(),
            analyticsQueue.getActiveCount(),
            analyticsQueue.getDelayedCount(),
          ]);

        reply.status(200).send({
          success: true,
          queues: {
            distance: {
              depth: distanceWaiting,
              active: distanceActive,
              delayed: distanceDelayed,
            },
            analytics: {
              depth: analyticsWaiting,
              active: analyticsActive,
              delayed: analyticsDelayed,
            },
          },
        });
      } catch (error) {
        _request.log.error({ error }, "Failed to fetch queue status");
        reply.status(500).send({
          success: false,
          error: "Failed to fetch queue status",
          requestId: _request.id,
        });
      }
    },
  );

  /**
   * GET /internal/snapshot-health
   *
   * Reports the freshness of each snapshot table.
   * A snapshot is considered "stale" if updated_at is older than 10 minutes —
   * the reconciliation job runs every 5 minutes, so >10 min indicates a jam.
   *
   * Requires: JWT authentication + ADMIN role.
   *
   * Response shape:
   * {
   *   success: true,
   *   data: {
   *     status: "healthy" | "degraded",
   *     tables: {
   *       employee_last_state:       { latestUpdateAt, rowCount, stale }
   *       org_dashboard_snapshot:    { latestUpdateAt, rowCount, stale }
   *       employee_metrics_snapshot: { latestUpdateAt, rowCount, stale }
   *     }
   *   }
   * }
   */
  app.get(
    "/internal/snapshot-health",
    {
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply): Promise<void> => {
      try {
        const { supabaseServiceClient: supabase } = await import("../config/supabase.js");
        const orgId = request.organizationId;
        const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

        const [elsResult, dashResult, metricsResult] = await Promise.allSettled([
          supabase
            .from("employee_last_state")
            .select("updated_at", { count: "exact", head: false })
            .eq("organization_id", orgId)
            .order("updated_at", { ascending: false })
            .limit(1),
          supabase
            .from("org_dashboard_snapshot")
            .select("updated_at", { count: "exact", head: false })
            .eq("organization_id", orgId)
            .limit(1),
          supabase
            .from("employee_metrics_snapshot")
            .select("updated_at", { count: "exact", head: false })
            .eq("organization_id", orgId)
            .order("updated_at", { ascending: false })
            .limit(1),
        ]);

        const now = Date.now();

        function analyseResult(
          result: PromiseSettledResult<{ data: Array<{ updated_at: string }> | null; count: number | null; error: unknown }>,
        ): { latestUpdateAt: string | null; rowCount: number; stale: boolean; error?: string } {
          if (result.status === "rejected") {
            return { latestUpdateAt: null, rowCount: 0, stale: true, error: String(result.reason) };
          }
          const { data, count } = result.value;
          const latestUpdateAt = data?.[0]?.updated_at ?? null;
          const stale = latestUpdateAt
            ? now - new Date(latestUpdateAt).getTime() > STALE_THRESHOLD_MS
            : true;
          return { latestUpdateAt, rowCount: count ?? 0, stale };
        }

        const tables = {
          employee_last_state: analyseResult(elsResult as PromiseSettledResult<{ data: Array<{ updated_at: string }> | null; count: number | null; error: unknown }>),
          org_dashboard_snapshot: analyseResult(dashResult as PromiseSettledResult<{ data: Array<{ updated_at: string }> | null; count: number | null; error: unknown }>),
          employee_metrics_snapshot: analyseResult(metricsResult as PromiseSettledResult<{ data: Array<{ updated_at: string }> | null; count: number | null; error: unknown }>),
        };

        const anyStale = Object.values(tables).some((t) => t.stale);
        const overallStatus = anyStale ? "degraded" : "healthy";

        reply.status(anyStale ? 503 : 200).send({
          success: true,
          data: {
            status: overallStatus,
            checkedAt: new Date().toISOString(),
            tables,
          },
        });
      } catch (error) {
        request.log.error({ error }, "Failed to fetch snapshot health");
        reply.status(500).send({
          success: false,
          error: "Failed to fetch snapshot health",
          requestId: request.id,
        });
      }
    },
  );
}
