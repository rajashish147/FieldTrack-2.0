import { Queue } from "bullmq";
import { getRedisConnectionOptions } from "../config/redis.js";
import { env } from "../config/env.js";
import { QueueOverloadedError } from "../utils/errors.js";
import { queueOverloadEventsTotal } from "../plugins/prometheus.js";

interface DistanceJobData {
  sessionId: string;
}

interface DistanceFailedJobData {
  originalData: DistanceJobData;
  failedAt: string;
  reason: string;
}

// ─── Lazy Queue Singletons ────────────────────────────────────────────────────
//
// Queue objects are created on first use rather than at module scope.
// This prevents Redis connections from being opened when the module is
// imported during tests or CI where Redis is unavailable.

let _distanceQueue: Queue<DistanceJobData> | undefined;
let _distanceFailedQueue: Queue<DistanceFailedJobData, void, "dead-letter"> | undefined;

function getDistanceQueue(): Queue<DistanceJobData> {
  return _distanceQueue ?? (_distanceQueue = new Queue("distance-engine", {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 1_000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    },
  }));
}

function getDistanceFailedQueue(): Queue<DistanceFailedJobData, void, "dead-letter"> {
  return _distanceFailedQueue ?? (_distanceFailedQueue = new Queue("distance-failed", {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      removeOnComplete: { count: 500 },
      removeOnFail: false,
    },
  }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueue a distance recalculation job for the given session.
 *
 * Idempotent: jobId = sessionId ensures that duplicate enqueue calls
 * for the same session produce only a single job in the queue.
 * BullMQ silently ignores duplicate jobIds that are already waiting.
 */
export async function enqueueDistanceJob(sessionId: string): Promise<void> {
  const queue = getDistanceQueue();
  const [waiting, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getDelayedCount(),
  ]);

  const queueDepth = waiting + delayed;
  if (queueDepth >= env.MAX_QUEUE_DEPTH) {
    // Alert hook: emit overload event counter
    queueOverloadEventsTotal.labels("distance-engine").inc();
    throw new QueueOverloadedError("distance-engine", queueDepth, env.MAX_QUEUE_DEPTH);
  }

  await getDistanceQueue().add(
    "recalculate",
    { sessionId },
    { jobId: sessionId },
  );
}

/**
 * Returns the count of jobs currently waiting in the queue.
 * Used by the metrics registry — decoupled so metrics.ts has no queue import.
 */
export async function getQueueDepth(): Promise<number> {
  return getDistanceQueue().getWaitingCount();
}

export const distanceFailedQueue = new Proxy(
  {} as Queue<DistanceFailedJobData, void, "dead-letter">,
  {
    get(_target, prop, receiver) {
      return Reflect.get(getDistanceFailedQueue(), prop, receiver);
    },
  },
);

export async function moveDistanceToDeadLetter(
  jobData: DistanceJobData,
  reason: string,
): Promise<void> {
  await getDistanceFailedQueue().add("dead-letter", {
    originalData: jobData,
    failedAt: new Date().toISOString(),
    reason,
  });
}

export async function replayDistanceDeadLetter(limit = 100): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const jobs = await getDistanceFailedQueue().getJobs(
    ["waiting", "delayed", "failed", "completed"],
    0,
    Math.max(0, boundedLimit - 1),
    true,
  );

  let replayed = 0;
  for (const job of jobs) {
    const sessionId = job.data.originalData?.sessionId;
    if (!sessionId) {
      continue;
    }
    await enqueueDistanceJob(sessionId);
    await job.remove();
    replayed++;
  }
  return replayed;
}

/** Lazy queue accessor — use this instead of the bare variable for external consumers. */
export const distanceQueue = new Proxy({} as Queue<DistanceJobData>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDistanceQueue(), prop, receiver);
  },
});
