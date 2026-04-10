/**
 * queue.ts — Centralized BullMQ queue options for FieldTrack 2.0.
 *
 * Standard retry policy (mirrors the distance-engine queue):
 *   attempts : 5
 *   backoff   : exponential, starting at 1 s → 2 s → 4 s → 8 s → 16 s
 *   removeOnComplete : true  (keep Redis memory lean)
 *   removeOnFail     : false (retain for operator inspection / replay)
 */

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
