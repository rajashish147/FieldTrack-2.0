import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { getAnalyticsQueueStats } from "../../workers/analytics.queue.js";
import { distanceQueue } from "../../workers/distance.queue.js";
import { handleError } from "../../utils/response.js";

// ─── Route registration ───────────────────────────────────────────────────────

/**
 * Phase 22: Admin queue monitoring endpoint.
 *
 * GET /admin/queues
 *
 * Returns current pending, active, completed, and failed job counts for both
 * the analytics queue and the distance-engine queue.  Also exposes the dead
 * letter queue (DLQ) depth so operators can see how many jobs need manual
 * replay.
 *
 * Auth: ADMIN only (JWT + role check).
 * No database reads — all counts come from Redis via BullMQ.
 */
export async function adminQueuesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/admin/queues",
    {
      schema: {
        tags: ["admin"],
        description:
          "Queue health dashboard — returns BullMQ job counts for analytics and distance queues (ADMIN only).",
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const [analyticsStats, distanceWaiting, distanceActive, distanceCompleted, distanceFailed] =
          await Promise.all([
            getAnalyticsQueueStats(),
            distanceQueue.getWaitingCount(),
            distanceQueue.getActiveCount(),
            distanceQueue.getCompletedCount(),
            distanceQueue.getFailedCount(),
          ]);

        reply.status(200).send({
          success: true,
          queues: {
            analytics: {
              waiting: analyticsStats.waiting,
              active: analyticsStats.active,
              completed: analyticsStats.completed,
              failed: analyticsStats.failed,
              dlq: analyticsStats.dlq,
            },
            distance: {
              waiting: distanceWaiting,
              active: distanceActive,
              completed: distanceCompleted,
              failed: distanceFailed,
            },
          },
        });
      } catch (error) {
        handleError(error, request, reply, "Failed to fetch queue stats");
      }
    },
  );
}
