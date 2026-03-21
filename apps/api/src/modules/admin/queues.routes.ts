import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { getAnalyticsQueueStats } from "../../workers/analytics.queue.js";
import { distanceQueue } from "../../workers/distance.queue.js";
import { replayDistanceDeadLetter } from "../../workers/distance.queue.js";
import { AppError } from "../../utils/errors.js";
import { handleError } from "../../utils/response.js";

const DLQ_REPLAY_COOLDOWN_MS = 15_000;
let lastDistanceDlqReplayAt = 0;

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

  app.post(
    "/admin/queues/replay-distance-dlq",
    {
      schema: {
        tags: ["admin"],
        body: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
        description:
          "Replay jobs from distance dead-letter queue back into the main distance queue (ADMIN only).",
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const body = z
          .object({ limit: z.number().int().min(1).max(500).default(100) })
          .parse(request.body ?? {});

        const now = Date.now();
        const sinceLastReplayMs = now - lastDistanceDlqReplayAt;
        if (sinceLastReplayMs < DLQ_REPLAY_COOLDOWN_MS) {
          const retryAfterMs = DLQ_REPLAY_COOLDOWN_MS - sinceLastReplayMs;
          request.log.warn(
            { queue: "distance-failed", retryAfterMs, cooldownMs: DLQ_REPLAY_COOLDOWN_MS },
            "Distance DLQ replay request rejected by cooldown guard",
          );
          throw new AppError(
            "Distance DLQ replay is rate-limited. Please wait before replaying again.",
            429,
            "DLQ_REPLAY_RATE_LIMITED",
            {
              queue: "distance-failed",
              retryAfterMs,
              cooldownMs: DLQ_REPLAY_COOLDOWN_MS,
            },
          );
        }

        const replayed = await replayDistanceDeadLetter(body.limit);
        lastDistanceDlqReplayAt = now;
        
        // Audit log: DLQ replay action
        request.log.info(
          {
            event: "DLQ_REPLAY_EXECUTED",
            severity: "info",
            queue: "distance-failed",
            replayed,
            limit: body.limit,
            admin_id: (request.user as { sub?: string } | undefined)?.sub,
            timestamp: new Date().toISOString(),
          },
          "Distance DLQ replay completed by admin",
        );
        
        reply.status(200).send({ success: true, replayed, limit: body.limit });
      } catch (error) {
        handleError(error, request, reply, "Failed to replay distance DLQ jobs");
      }
    },
  );
}
