/**
 * queue.ts — Centralized BullMQ queue factory for FieldTrack 2.0.
 *
 * Provides a single createQueue() function that applies the standard retry
 * policy and Redis connection config to every queue in the system.
 *
 * Phase 25 foundation: the webhook delivery queue will be the first consumer
 * of this factory.  Existing queues (distance-engine, analytics) may migrate
 * to this factory in a future cleanup pass — do not change them now.
 *
 * Standard retry policy (mirrors the distance-engine queue):
 *   attempts : 5
 *   backoff   : exponential, starting at 1 s → 2 s → 4 s → 8 s → 16 s
 *   removeOnComplete : true  (keep Redis memory lean)
 *   removeOnFail     : false (retain for operator inspection / replay)
 */

import { Queue } from "bullmq";
import { redisConnectionOptions } from "../config/redis.js";

// ─── Standard Job Options ─────────────────────────────────────────────────────

/**
 * Shared default job options applied to every queue created via createQueue().
 * Override per-queue by passing custom defaultJobOptions to new Queue() directly
 * when a queue has non-standard requirements (e.g. the analytics delay).
 */
export const standardJobOptions = {
  attempts: 5,
  backoff: {
    type: "exponential" as const,
    delay: 1_000, // 1 s → 2 s → 4 s → 8 s → 16 s
  },
  removeOnComplete: true,
  removeOnFail: false,
} as const;

// ─── Queue Factory ────────────────────────────────────────────────────────────

/**
 * Create a BullMQ queue with the standard FieldTrack configuration.
 *
 * All queues share the same Redis connection options and retry policy so that
 * operational behaviour is consistent and predictable across the system.
 *
 * @param name   Queue name — must be unique per Redis instance.
 *               Convention: kebab-case, e.g. "webhook-delivery".
 *
 * @example
 *   import { createQueue } from "../../lib/queue.js";
 *   const webhookQueue = createQueue<WebhookJobData>("webhook-delivery");
 */
export function createQueue<TData = unknown>(name: string): Queue<TData> {
  return new Queue<TData>(name, {
    connection: redisConnectionOptions,
    defaultJobOptions: standardJobOptions,
  });
}
