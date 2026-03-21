import { Queue } from "bullmq";
import { getRedisConnectionOptions } from "../config/redis.js";
import { env } from "../config/env.js";
import { QueueOverloadedError } from "../utils/errors.js";
import { queueOverloadEventsTotal } from "../plugins/prometheus.js";

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

// ─── Lazy Queue Singletons ────────────────────────────────────────────────────
//
// Queue objects are created on first use rather than at module scope.
// This prevents Redis connections from being opened when the module is
// imported during tests or CI where Redis is unavailable.

let _analyticsQueue: Queue<AnalyticsJobData> | undefined;
let _analyticsFailedQueue: Queue<AnalyticsFailedJobData, void, "dead-letter"> | undefined;

function getAnalyticsQueue(): Queue<AnalyticsJobData> {
  return _analyticsQueue ?? (_analyticsQueue = new Queue<AnalyticsJobData>("analytics", {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      delay: 10_000,
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5_000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    },
  }));
}

function getAnalyticsFailedQueue(): Queue<AnalyticsFailedJobData, void, "dead-letter"> {
  return _analyticsFailedQueue ?? (_analyticsFailedQueue = new Queue<AnalyticsFailedJobData, void, "dead-letter">(
    "analytics-failed",
    {
      connection: getRedisConnectionOptions(),
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        removeOnFail: false,
      },
    },
  ));
}

export const analyticsFailedQueue = new Proxy(
  {} as Queue<AnalyticsFailedJobData, void, "dead-letter">,
  {
    get(_target, prop, receiver) {
      return Reflect.get(getAnalyticsFailedQueue(), prop, receiver);
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
  await getAnalyticsFailedQueue().add("dead-letter", {
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
  const queue = getAnalyticsQueue();
  const [waiting, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getDelayedCount(),
  ]);

  const queueDepth = waiting + delayed;
  if (queueDepth >= env.MAX_QUEUE_DEPTH) {
    queueOverloadEventsTotal.labels("analytics").inc();
    throw new QueueOverloadedError("analytics", queueDepth, env.MAX_QUEUE_DEPTH);
  }

  await queue.add(
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
  return getAnalyticsQueue().getWaitingCount();
}

/**
 * Returns queue stat counts for both the main analytics queue and the dead
 * letter queue.  Used by the /admin/queues monitoring endpoint.
 */
export async function getAnalyticsQueueStats() {
  const [waiting, active, completed, failed, dlqWaiting, dlqFailed] =
    await Promise.all([
      getAnalyticsQueue().getWaitingCount(),
      getAnalyticsQueue().getActiveCount(),
      getAnalyticsQueue().getCompletedCount(),
      getAnalyticsQueue().getFailedCount(),
      getAnalyticsFailedQueue().getWaitingCount(),
      getAnalyticsFailedQueue().getFailedCount(),
    ]);
  return { waiting, active, completed, failed, dlq: { waiting: dlqWaiting, failed: dlqFailed } };
}

/** Lazy queue accessor for external consumers. */
export const analyticsQueue = new Proxy({} as Queue<AnalyticsJobData>, {
  get(_target, prop, receiver) {
    return Reflect.get(getAnalyticsQueue(), prop, receiver);
  },
});
