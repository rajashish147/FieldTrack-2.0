import { Worker } from "bullmq";
import type { Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import { redisConnectionOptions } from "../config/redis.js";
import { enqueueDistanceJob } from "./distance.queue.js";
import { sessionSummaryService } from "../modules/session_summary/session_summary.service.js";
import { metrics } from "../utils/metrics.js";

// ─── Job Payload Shape ────────────────────────────────────────────────────────

interface DistanceJobData {
  sessionId: string;
}

// ─── Number of recovered sessions batched per event-loop tick ────────────────
const RECOVERY_BATCH_SIZE = 50;

// ─── Worker Start Guard ───────────────────────────────────────────────────────

/**
 * Phase 11: Prevents the worker from being started more than once per process.
 * Hot-reload (tsx watch) or accidental double-call in app.ts must not spawn
 * duplicate BullMQ workers competing over the same Redis queue.
 */
let workerStarted = false;

// ─── Worker ───────────────────────────────────────────────────────────────────

/**
 * Phase 10: BullMQ distance worker.
 *
 * Replaces the Phase 7 perpetual while-true in-memory loop with a proper
 * durable worker backed by Redis. Key improvements:
 *  - Jobs survive process crashes (persisted in Redis)
 *  - Automatic retry with exponential backoff (5 attempts)
 *  - Job deduplication via jobId = sessionId
 *  - No event-loop blocking — BullMQ handles concurrency via its own scheduler
 *  - Structured logs on every job with jobId + executionTimeMs correlation
 *
 * Phase 11: Guarded by workerStarted flag — idempotent across hot reloads.
 *
 * @param app - Fastify instance used for structured logging and session data access
 */
export function startDistanceWorker(app: FastifyInstance): Worker | null {
  if (workerStarted) {
    app.log.warn("startDistanceWorker called more than once — ignoring duplicate start");
    return null;
  }
  workerStarted = true;
  const worker = new Worker<DistanceJobData>(
    "distance-engine",
    async (job: Job<DistanceJobData>): Promise<void> => {
      const { sessionId } = job.data;
      const jobId = job.id ?? sessionId;
      const startedAt = Date.now();

      app.log.info({ jobId, sessionId }, "Distance worker: picked up job");

      try {
        await sessionSummaryService.calculateAndSaveSystem(app, sessionId);

        const executionTimeMs = Date.now() - startedAt;
        metrics.recordRecalculationTime(executionTimeMs);
        metrics.incrementRecalculations();

        app.log.info(
          { jobId, sessionId, executionTimeMs },
          "Distance worker: job completed successfully",
        );
      } catch (error: unknown) {
        const executionTimeMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);

        app.log.error(
          { jobId, sessionId, executionTimeMs, error: message },
          "Distance worker: job failed",
        );

        // Re-throw so BullMQ records the failure and applies backoff/retry
        throw error;
      }
    },
    { connection: redisConnectionOptions, concurrency: 1 },
  );

  worker.on("error", (err: Error) => {
    app.log.error({ error: err.message }, "Distance worker: uncaught worker error");
  });

  app.log.info("Phase 10: BullMQ distance worker started");

  return worker;
}

// ─── Crash Recovery ───────────────────────────────────────────────────────────

/**
 * Phase 10: Crash recovery re-enqueue using durable BullMQ jobs.
 *
 * Called AFTER app.listen() resolves in server.ts — never inside buildApp() —
 * so the recovery scan never blocks the server from accepting traffic.
 *
 * Orphaned sessions (checked-out but missing or stale summary) are re-enqueued
 * into Redis in small batches using setImmediate so the event loop is not
 * saturated during the recovery window.
 *
 * Collision safety: enqueueDistanceJob() uses jobId = sessionId — BullMQ
 * silently ignores duplicates already waiting in the queue.
 */
export async function performStartupRecovery(
  fastifyApp: FastifyInstance,
): Promise<void> {
  try {
    fastifyApp.log.info("Phase 10: starting crash recovery scan");

    // Dynamic import avoids a circular-dependency chain at module load time
    const { attendanceRepository } =
      await import("../modules/attendance/attendance.repository.js");

    const orphans = await attendanceRepository.findSessionsNeedingRecalculation(
      fastifyApp.log,
    );

    if (orphans.length === 0) {
      fastifyApp.log.info(
        "Phase 10: crash recovery complete — no orphaned sessions found",
      );
      return;
    }

    fastifyApp.log.info(
      { orphanCount: orphans.length },
      "Phase 10: orphaned sessions found — scheduling batched re-enqueue",
    );

    let batchStart = 0;
    let totalEnqueued = 0;

    const enqueueBatch = (): void => {
      const end = Math.min(batchStart + RECOVERY_BATCH_SIZE, orphans.length);
      const batch = orphans.slice(batchStart, end);

      // Fire-and-forget async enqueue inside synchronous setImmediate callback.
      // Errors are caught and logged individually to avoid blocking the batch loop.
      for (const session of batch) {
        enqueueDistanceJob(session.id)
          .then(() => {
            totalEnqueued++;
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            fastifyApp.log.warn(
              { sessionId: session.id, error: message },
              "Phase 10: failed to enqueue orphaned session during recovery",
            );
          });
      }

      batchStart = end;

      if (batchStart < orphans.length) {
        setImmediate(enqueueBatch);
      } else {
        fastifyApp.log.info(
          { orphanCount: orphans.length, totalEnqueued },
          "Phase 10: crash recovery re-enqueue complete",
        );
        metrics.incrementRecalculations();
      }
    };

    setImmediate(enqueueBatch);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    fastifyApp.log.error(
      { error: message },
      "Phase 10: crash recovery scan failed — some sessions may need manual recalculation",
    );
  }
}
