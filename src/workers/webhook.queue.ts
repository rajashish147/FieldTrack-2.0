/**
 * webhook.queue.ts — BullMQ queue for async webhook delivery.
 *
 * Design follows the existing distance.queue.ts lazy-singleton pattern:
 *  - Queue object is created on first use, not at import time.
 *  - This prevents Redis connections from being opened in CI / test
 *    environments where Redis is not available.
 *
 * Job payload contains everything the worker needs to sign and deliver
 * the request without additional DB round-trips in the hot path.
 *
 * DLQ retention
 * ─────────────
 *  - Max DLQ size:     WEBHOOK_DLQ_MAX_SIZE  (default 10 000 jobs)
 *  - Retention window: WEBHOOK_DLQ_RETENTION_DAYS (default 30 days)
 *  - Jobs older than the window are archived to webhook_dlq_archive (DB)
 *    then removed from Redis.
 *  - purgeDlqJobs() is called on process start and every hour by the
 *    purge interval started in webhook.worker.ts.
 */

import { Queue } from "bullmq";
import { getRedisConnectionOptions } from "../config/redis.js";
import { env } from "../config/env.js";
import { QueueOverloadedError } from "../utils/errors.js";
import { supabaseServiceClient as supabase } from "../config/supabase.js";
import { insertAuditRecord } from "../utils/audit.js";

// ─── Job Payload ──────────────────────────────────────────────────────────────

export interface WebhookDeliveryJobData {
  /** Delivery row id in webhook_deliveries — used for idempotent updates */
  delivery_id: string;
  /** Webhook registration id */
  webhook_id: string;
  /** Event row id in webhook_events */
  event_id: string;
  /** Target endpoint URL (HTTPS, already validated at registration) */
  url: string;
  /**
   * Per-webhook signing secret.
   *
   * NOTE: This travels through Redis. In a high-security environment the
   * secret should instead be fetched from the DB inside the worker on each
   * attempt. We accept the Redis-in-transit risk here because the Redis
   * connection is TLS-encrypted in production (rediss://) and the secret is
   * only used for HMAC signing — it does NOT grant DB access.
   */
  secret: string;
  /** Current delivery attempt number (1-based) */
  attempt_number: number;
}

// ─── Queue name constant ──────────────────────────────────────────────────────

export const WEBHOOK_QUEUE_NAME = "webhook-delivery" as const;

// ─── Retry back-off delays (milliseconds) ────────────────────────────────────
//
// Attempt 1 → immediate (delay = 0, handled as first-try in BullMQ)
// Attempt 2 → 1 min
// Attempt 3 → 5 min
// Attempt 4 → 15 min
// Attempt 5 → 1 h
//
// Production-grade exponential backoff matching the audit spec.
// After attempt 5 fails, the delivery moves to the Dead-Letter Queue (DLQ).

export const WEBHOOK_RETRY_DELAYS_MS: ReadonlyArray<number> = [
  0,           // attempt 1 — immediate
  60_000,      // attempt 2 — 1 min
  300_000,     // attempt 3 — 5 min
  900_000,     // attempt 4 — 15 min
  3_600_000,   // attempt 5 — 1 h
];

export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length;

/**
 * Calculate retry delay with one-sided 0-20% jitter to prevent thundering herd.
 *
 * Without jitter, 100 failed deliveries all retry at the same time,
 * creating a synchronized spike that can cascade. Jitter spreads retries
 * across a window, stabilizing the system.
 *
 * Example: baseDelay=60s → 60-72s range (+0-20% jitter)
 *
 * @param attemptNumber 1-based attempt number (1=first retry, 2=second, etc.)
 * @returns delay in milliseconds for this retry
 */
export function calculateRetryDelay(attemptNumber: number): number {
  const baseDelay = WEBHOOK_RETRY_DELAYS_MS[attemptNumber - 1];
  if (baseDelay === 0) return 0; // attempt 1 is always immediate — no jitter
  // Mandatory formula: delay = base + random(0-20% of base)
  const jitterMs = baseDelay * 0.2 * Math.random();
  return Math.round(baseDelay + jitterMs);
}

// ─── Lazy Queue Singleton ─────────────────────────────────────────────────────

let _webhookQueue: Queue<WebhookDeliveryJobData> | undefined;

function getWebhookQueue(): Queue<WebhookDeliveryJobData> {
  if (_webhookQueue) return _webhookQueue;

  _webhookQueue = new Queue<WebhookDeliveryJobData>(WEBHOOK_QUEUE_NAME, {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      // Each job is attempted once by BullMQ — retry scheduling is managed
      // manually by the worker so we can record attempt state in the DB and
      // implement exact delays without relying on BullMQ's built-in backoff.
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { count: 500 },
    },
  });

  return _webhookQueue;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueue a webhook delivery job.
 *
 * The job ID is `delivery:{delivery_id}:{attempt_number}` to ensure
 * each attempt is a distinct job while allowing the delivery_id to
 * correlate all attempts for a single delivery row.
 *
 * @throws {QueueOverloadedError} when the queue depth exceeds MAX_QUEUE_DEPTH.
 */
export async function enqueueWebhookDelivery(
  data: WebhookDeliveryJobData,
  delayMs = 0,
): Promise<void> {
  const queue = getWebhookQueue();

  const [waiting, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getDelayedCount(),
  ]);

  const depth = waiting + delayed;
  if (depth >= env.MAX_QUEUE_DEPTH) {
    throw new QueueOverloadedError(WEBHOOK_QUEUE_NAME, depth, env.MAX_QUEUE_DEPTH);
  }

  await queue.add(
    "deliver-webhook",
    data,
    {
      jobId: `delivery:${data.delivery_id}:${data.attempt_number}`,
      delay: delayMs,
      // Priority ensures fresh first-attempt deliveries are never starved by
      // a flood of retry jobs under sustained load.
      // BullMQ priority: lower number = higher priority (1 = highest).
      //   attempt 1 (first delivery) → priority 1 — processed first
      //   attempt 2+  (retries)      → priority 2 — processed after fresh jobs
      priority: data.attempt_number === 1 ? 1 : 2,
    },
  );
}

/**
 * Return the combined waiting + delayed count.
 * Exposed for metrics and admin health checks.
 */
export async function getWebhookQueueDepth(): Promise<number> {
  const queue = getWebhookQueue();
  const [waiting, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getDelayedCount(),
  ]);
  return waiting + delayed;
}

// ─── Dead-Letter Queue (DLQ) ─────────────────────────────────────────────────
//
// Jobs that exhaust all retry attempts are moved here for visibility and
// potential manual reprocessing by admins. The DLQ is a separate BullMQ
// queue so it does not pollute the main delivery queue metrics.

export const WEBHOOK_DLQ_NAME = "webhook-delivery-dlq" as const;

let _webhookDlq: Queue<WebhookDeliveryJobData> | undefined;

function getWebhookDlq(): Queue<WebhookDeliveryJobData> {
  if (_webhookDlq) return _webhookDlq;

  _webhookDlq = new Queue<WebhookDeliveryJobData>(WEBHOOK_DLQ_NAME, {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: false, // keep DLQ entries for admin inspection
      removeOnFail: false,
    },
  });

  return _webhookDlq;
}

/**
 * Move a permanently failed delivery job to the Dead-Letter Queue.
 *
 * Enforces DLQ_MAX_SIZE: if the DLQ is at capacity, the oldest job is
 * archived and evicted before the new job is added.
 */
export async function enqueueToDlq(data: WebhookDeliveryJobData): Promise<void> {
  const dlq = getWebhookDlq();

  // ── Max-size guard ────────────────────────────────────────────────────────
  const depth = await dlq.getWaitingCount();
  if (depth >= env.WEBHOOK_DLQ_MAX_SIZE) {
    // Evict the oldest job to stay within the cap.
    const [oldest] = await dlq.getWaiting(0, 0);
    if (oldest) {
      await _archiveAndRemoveDlqJob(oldest, "max_size_eviction");
    }
  }

  await dlq.add(
    "dlq-delivery",
    data,
    { jobId: `dlq:${data.delivery_id}` },
  );
}

/**
 * Return the current DLQ depth for health monitoring.
 */
export async function getWebhookDlqDepth(): Promise<number> {
  const dlq = getWebhookDlq();
  return dlq.getWaitingCount();
}

/**
 * Replay a single DLQ job by delivery ID.
 *
 * Called from `POST /admin/webhook-dlq/:deliveryId/replay`.
 * Moves the job back to the main delivery queue for re-attempt.
 *
 * @returns `true` if the job was found and replayed, `false` if not found.
 */
export async function replayWebhookDlqJob(deliveryId: string): Promise<boolean> {
  const dlq = getWebhookDlq();
  const jobId = `dlq:${deliveryId}`;
  const job = await dlq.getJob(jobId);
  if (!job) return false;

  // Re-enqueue in main queue with attempt_number reset to 1 — fresh start.
  const data: WebhookDeliveryJobData = { ...job.data, attempt_number: 1 };
  await enqueueWebhookDelivery(data, 0);
  await job.remove();
  return true;
}

/**
 * List all jobs currently in the DLQ (up to `limit`).
 * Used by the admin review UI.
 */
export async function listWebhookDlqJobs(
  limit = 50,
): Promise<Array<{ jobId: string; data: WebhookDeliveryJobData; failedAt?: number }>> {
  const dlq = getWebhookDlq();
  const jobs = await dlq.getWaiting(0, limit - 1);
  return jobs.map((j) => ({
    jobId:    j.id ?? "(unknown)",
    data:     j.data,
    failedAt: j.timestamp,
  }));
}

// ─── DLQ Retention / Purge ────────────────────────────────────────────────────

/**
 * Archive a single DLQ job to the DB then remove it from Redis.
 * Internal helper; exported for testability.
 */
export async function _archiveAndRemoveDlqJob(
  job: { id?: string; data: WebhookDeliveryJobData; timestamp: number },
  reason: string,
): Promise<void> {
  const { data } = job;
  const failedAt = new Date(job.timestamp).toISOString();

  await supabase.from("webhook_dlq_archive").insert({
    delivery_id:    data.delivery_id,
    webhook_id:     data.webhook_id,
    event_id:       data.event_id,
    url:            data.url,
    attempt_number: data.attempt_number,
    failed_at:      failedAt,
    reason,
  });

  await insertAuditRecord({
    event: "WEBHOOK_DLQ_DELETED",
    resource_type: "webhook_delivery",
    resource_id: data.delivery_id,
    payload: {
      webhook_id: data.webhook_id,
      event_id: data.event_id,
      attempt_number: data.attempt_number,
      failed_at: failedAt,
      reason,
    },
  });

  // Remove from BullMQ after successful archive write.
  // If the archive insert failed, Supabase-js throws so the job is NOT removed —
  // the retention policy degrades gracefully to "keep but warn" rather than lose data.
  const dlq = getWebhookDlq();
  const liveJob = job.id ? await dlq.getJob(job.id) : undefined;
  await liveJob?.remove();
}

/**
 * Purge DLQ jobs older than WEBHOOK_DLQ_RETENTION_DAYS.
 *
 * For each expired job:
 *  1. Archive payload to webhook_dlq_archive (DB)
 *  2. Remove from BullMQ (Redis)
 *
 * Also enforces WEBHOOK_DLQ_MAX_SIZE: if depth still exceeds the cap after
 * expiry-based purge, continues evicting oldest jobs until under the cap.
 *
 * Call on startup and then every hour (managed by startDlqPurgeInterval()).
 *
 * @returns count of jobs archived and removed
 */
export async function purgeDlqJobs(log?: { info: (msg: string, ctx?: object) => void; warn: (msg: string, ctx?: object) => void }): Promise<number> {
  const dlq = getWebhookDlq();
  const retentionMs = env.WEBHOOK_DLQ_RETENTION_DAYS * 24 * 3_600_000;
  const cutoffMs    = Date.now() - retentionMs;

  // Fetch all waiting jobs — DLQ is expected to be small (O(hundreds) max)
  const allJobs   = await dlq.getWaiting(0, -1);
  const expired   = allJobs.filter((j) => j.timestamp < cutoffMs);
  let   purgeCount = 0;

  for (const job of expired) {
    try {
      await _archiveAndRemoveDlqJob(job, "retention_policy");
      purgeCount++;
    } catch (err) {
      log?.warn("dlq-purge: failed to archive job", {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // After expiry purge, enforce max size by evicting oldest remaining jobs.
  const remaining = await dlq.getWaiting(0, -1);
  const overflow  = remaining.length - env.WEBHOOK_DLQ_MAX_SIZE;
  if (overflow > 0) {
    // Oldest first (lowest timestamp)
    const toEvict = remaining
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, overflow);

    for (const job of toEvict) {
      try {
        await _archiveAndRemoveDlqJob(job, "max_size_eviction");
        purgeCount++;
      } catch (err) {
        log?.warn("dlq-purge: failed to evict overflow job", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (purgeCount > 0) {
    log?.info("dlq-purge: completed", { purgeCount, retentionDays: env.WEBHOOK_DLQ_RETENTION_DAYS });
  }

  return purgeCount;
}

/** Purge interval handle — stored so the interval can be cleared in tests. */
let _dlqPurgeInterval: ReturnType<typeof setInterval> | undefined;

/**
 * Start the hourly DLQ purge background interval.
 * Returns the interval handle for cleanup.  Safe to call multiple times.
 */
export function startDlqPurgeInterval(
  log?: { info: (msg: string, ctx?: object) => void; warn: (msg: string, ctx?: object) => void },
): ReturnType<typeof setInterval> {
  if (_dlqPurgeInterval) return _dlqPurgeInterval;

  // Run once immediately on startup, then every hour.
  void purgeDlqJobs(log);

  _dlqPurgeInterval = setInterval(
    () => { void purgeDlqJobs(log); },
    3_600_000, // 1 hour
  );
  _dlqPurgeInterval.unref(); // Don't block process exit

  return _dlqPurgeInterval;
}
