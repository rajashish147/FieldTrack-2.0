/**
 * system-health.routes.ts — Deep system health endpoint for operators.
 *
 * GET /admin/system-health
 *
 * Returns a single-call view of:
 *  - Worker status (expected 3-of-3: distance, analytics, webhook)
 *  - Queue backlog (waiting + delayed jobs per queue)
 *  - Webhook DLQ depth
 *  - Webhook delivery stats: success rate, failure count, retry count
 *
 * Auth: ADMIN only (JWT + role check).
 * Redis reads only — no heavy DB aggregation in the hot path.
 * Webhook stats use a lightweight DB count query scoped to the org.
 */

import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { areWorkersStarted, getExpectedWorkerCount } from "../../workers/startup.js";
import { getWebhookQueueDepth, getWebhookDlqDepth } from "../../workers/webhook.queue.js";
import { getAnalyticsQueueStats } from "../../workers/analytics.queue.js";
import { distanceQueue } from "../../workers/distance.queue.js";
import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import { handleError } from "../../utils/response.js";

const EXPECTED_WORKER_COUNT = getExpectedWorkerCount(); // distance + analytics + webhook (driven by WORKER_TYPES)

export async function systemHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/admin/system-health",
    {
      schema: {
        tags: ["admin"],
        description:
          "Deep system health: worker status, queue backlogs, DLQ depth, and webhook delivery stats (ADMIN only).",
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const orgId = (request as { organizationId?: string }).organizationId;

        // ── Worker status ──────────────────────────────────────────────────
        const workersActive = areWorkersStarted() ? EXPECTED_WORKER_COUNT : 0;

        // ── Queue depths (Redis) ───────────────────────────────────────────
        const [
          webhookQueueDepth,
          webhookDlqDepth,
          analyticsStats,
          distanceWaiting,
          distanceDelayed,
        ] = await Promise.allSettled([
          getWebhookQueueDepth(),
          getWebhookDlqDepth(),
          getAnalyticsQueueStats(),
          distanceQueue.getWaitingCount(),
          distanceQueue.getDelayedCount(),
        ]);

        const safeNumber = (r: PromiseSettledResult<number>) =>
          r.status === "fulfilled" ? r.value : -1;

        const analyticsQueueDepth =
          analyticsStats.status === "fulfilled"
            ? analyticsStats.value.waiting + (analyticsStats.value.active ?? 0)
            : -1;

        // ── Webhook delivery stats (DB, org-scoped) ────────────────────────
        let webhookSuccessRate = 0;
        let webhookFailureCount = 0;
        let webhookRetryCount = 0;
        let webhookTotalCount = 0;

        if (orgId) {
          const { data: stats } = await supabase
            .from("webhook_deliveries")
            .select("status, attempt_count")
            .eq("organization_id", orgId)
            .limit(500);

          if (stats) {
            webhookTotalCount = stats.length;
            const successes = stats.filter((r) => r.status === "success").length;
            webhookFailureCount = stats.filter((r) => r.status === "failed").length;
            // Retry count = total attempts beyond the first across all deliveries
            webhookRetryCount = stats.reduce(
              (sum, r) => sum + Math.max(0, (r.attempt_count ?? 0) - 1),
              0,
            );
            webhookSuccessRate =
              webhookTotalCount > 0
                ? Math.round((successes / webhookTotalCount) * 100)
                : 100; // 100% if no deliveries yet
          }
        }

        reply.status(200).send({
          success: true,
          timestamp: new Date().toISOString(),
          workers: {
            active: workersActive,
            expected: EXPECTED_WORKER_COUNT,
            healthy: workersActive === EXPECTED_WORKER_COUNT,
          },
          queues: {
            webhook: {
              backlog: safeNumber(webhookQueueDepth),
              dlq:     safeNumber(webhookDlqDepth),
            },
            analytics: {
              backlog: analyticsQueueDepth,
            },
            distance: {
              backlog:
                safeNumber(distanceWaiting) >= 0 && safeNumber(distanceDelayed) >= 0
                  ? safeNumber(distanceWaiting) + safeNumber(distanceDelayed)
                  : -1,
            },
          },
          webhooks: {
            successRatePct: webhookSuccessRate,
            failureCount:   webhookFailureCount,
            retryCount:     webhookRetryCount,
            totalDeliveries: webhookTotalCount,
          },
        });
      } catch (error) {
        handleError(error, request, reply, "Failed to fetch system health");
      }
    },
  );
}
