import { Queue } from "bullmq";
import { redisConnectionOptions } from "../config/redis.js";

// ─── Dead Letter Queue Payload ────────────────────────────────────────────────

export interface AnalyticsFailedJobData {
  /** Original job payload that permanently failed. */
  originalData: AnalyticsJobData;
  /** ISO timestamp of when the job was moved to the dead letter queue. */
  failedAt: string;
  /** Error message from the final failed attempt. */
  reason: string;
}

// ─── Job Payload Shape ────────────────────────────────────────────────────────

export interface AnalyticsJobData {
  sessionId: string;
  organizationId: string;
  employeeId: string;
}

// ─── Queue Definition ─────────────────────────────────────────────────────────

/**
 * Phase 21: Dedicated BullMQ queue for analytics aggregation jobs.
 *
 * Each job is triggered by a session checkout and performs a full idempotent
 * recompute of employee_daily_metrics and org_daily_metrics for the session's
 * date. Jobs use the session distance data that the distance worker writes
 * to attendance_sessions.total_distance_km.
 *
 * Retry strategy: 3 attempts with 5 s initial exponential backoff.  The first
 * attempt fires ~5 s after checkout; by then the distance worker has almost
 * certainly written its result.  On the rare case it hasn't, the second retry
 * at ~10 s will succeed.
 *
 * Deduplication: jobId = `analytics:<sessionId>` ensures that duplicate
 * enqueue calls for the same session (e.g. retry of the checkout endpoint)
 * produce only a single job in the queue.
 *
 * Rate limiter: caps throughput at 50 jobs/second to protect the database
 * from spikes during bulk checkout events or backfill runs.
 */
const analyticsQueue = new Queue<AnalyticsJobData>("analytics", {
  connection: redisConnectionOptions,
  defaultJobOptions: {
    // Phase 22: 10 s delay so the distance worker has time to write its result
    // before the analytics worker picks up the job.  The distance worker
    // typically finishes within 5 s; the extra margin prevents the first
    // retry from being wasted on a still-pending distance calculation.
    delay: 10_000,
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5_000, // 5 s → 10 s → 20 s; gives distance worker time to finish
    },
    removeOnComplete: true,
    removeOnFail: false, // Retain failed jobs for operator inspection
  },
});

// ─── Dead Letter Queue ────────────────────────────────────────────────────────

/**
 * Phase 22: Dedicated dead letter queue for analytics jobs that exhausted all
 * retry attempts.  Jobs here need manual operator review / replay.
 *
 * Retention: keep the last 500 failed jobs indefinitely for inspection.
 * Operators can manually re-enqueue via the /admin/queues stats endpoint or
 * directly via BullMQ tooling.
 */
// NameType is pinned to the literal "dead-letter" so Queue.add() is type-safe
// in BullMQ v5, which uses ExtractNameType to derive the allowed job name.
export const analyticsFailedQueue = new Queue<AnalyticsFailedJobData, void, "dead-letter">(
  "analytics-failed",
  {
    connection: redisConnectionOptions,
    defaultJobOptions: {
      removeOnComplete: { count: 500 },
      removeOnFail: false,
    },
  },
);

/**
 * Move a permanently failed analytics job to the dead letter queue.
 * Safe to call from the worker's `failed` event handler.
 */
export async function moveToDeadLetter(
  jobData: AnalyticsJobData,
  reason: string,
): Promise<void> {
  await analyticsFailedQueue.add("dead-letter", {
    originalData: jobData,
    failedAt: new Date().toISOString(),
    reason,
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueue an analytics aggregation job for the given session.
 *
 * Idempotent: duplicate calls for the same sessionId are silently ignored by
 * BullMQ because the jobId is deterministic (analytics:<sessionId>).
 *
 * The 10 s delay (inherited from defaultJobOptions) is intentional: it ensures
 * the distance worker has finished writing total_distance_km before the analytics
 * worker picks up the job, avoiding a wasted first attempt and retry.
 */
export async function enqueueAnalyticsJob(
  sessionId: string,
  organizationId: string,
  employeeId: string,
): Promise<void> {
  await analyticsQueue.add(
    "update-metrics",
    { sessionId, organizationId, employeeId },
    { jobId: `analytics:${sessionId}` },
  );
}

/**
 * Returns the count of jobs currently waiting in the analytics queue.
 * Consumed by the Prometheus metrics collector.
 */
export async function getAnalyticsQueueDepth(): Promise<number> {
  return analyticsQueue.getWaitingCount();
}

/**
 * Returns queue stat counts for both the main analytics queue and the dead
 * letter queue.  Used by the /admin/queues monitoring endpoint.
 */
export async function getAnalyticsQueueStats() {
  const [waiting, active, completed, failed, dlqWaiting, dlqFailed] =
    await Promise.all([
      analyticsQueue.getWaitingCount(),
      analyticsQueue.getActiveCount(),
      analyticsQueue.getCompletedCount(),
      analyticsQueue.getFailedCount(),
      analyticsFailedQueue.getWaitingCount(),
      analyticsFailedQueue.getFailedCount(),
    ]);
  return { waiting, active, completed, failed, dlq: { waiting: dlqWaiting, failed: dlqFailed } };
}

export { analyticsQueue };
