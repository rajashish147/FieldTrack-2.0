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
}
