import { Worker } from "bullmq";
import type { Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { redisConnectionOptions } from "../config/redis.js";
import { enqueueDistanceJob } from "./distance.queue.js";
import { moveDistanceToDeadLetter } from "./distance.queue.js";
import { sessionSummaryService } from "../modules/session_summary/session_summary.service.js";
import { metrics } from "../utils/metrics.js";
import { distanceJobsTotal } from "../plugins/prometheus.js";
import { env } from "../config/env.js";
import { supabaseServiceClient as supabase } from "../config/supabase.js";

// ─── Job Payload Shape ────────────────────────────────────────────────────────

interface DistanceJobData {
  sessionId: string;
}

// ─── Number of recovered sessions batched per event-loop tick ────────────────
const RECOVERY_BATCH_SIZE = 50;

// ─── Worker Start Guard ───────────────────────────────────────────────────────

let workerStarted = false;

// ─── Worker ───────────────────────────────────────────────────────────────────

export function startDistanceWorker(app: FastifyInstance): Worker | null {
  if (workerStarted) {
    app.log.warn("startDistanceWorker called more than once — ignoring duplicate start");
    return null;
  }

  workerStarted = true;

  const tracer = trace.getTracer("bullmq-worker");

  const worker = new Worker<DistanceJobData>(
    "distance-engine",
    async (job: Job<DistanceJobData>): Promise<void> => {
      const startedAt = Date.now();

      return tracer.startActiveSpan("bullmq.process_job", async (span) => {
        const { sessionId } = job.data;
        const jobId = job.id ?? sessionId;

        try {
          // ─── Span Attributes ────────────────────────────────────────────────

          span.setAttribute("worker.name", "distance-worker");
          span.setAttribute("queue.name", "distance-engine");
          span.setAttribute("job.id", jobId);
          span.setAttribute("job.name", job.name ?? "distance-engine");
          span.setAttribute("job.attempts", job.attemptsMade);
          span.setAttribute("job.timestamp", job.timestamp);
          span.setAttribute("session.id", sessionId);

          app.log.info({ jobId, sessionId }, "Distance worker: picked up job");

          await sessionSummaryService.calculateAndSaveSystem(app, sessionId);

          const executionTimeMs = Date.now() - startedAt;

          metrics.recordRecalculationTime(executionTimeMs);
          metrics.incrementRecalculations();
          distanceJobsTotal.inc({ status: "success" });

          span.setAttribute("execution_time_ms", executionTimeMs);
          span.setStatus({ code: SpanStatusCode.OK });

          app.log.info(
            { jobId, sessionId, executionTimeMs },
            "Distance worker: job completed successfully",
          );

          return;
        } catch (error: unknown) {
          const executionTimeMs = Date.now() - startedAt;
          const message = error instanceof Error ? error.message : String(error);

          if (error instanceof Error) {
            span.recordException(error);
          }

          span.setStatus({ code: SpanStatusCode.ERROR });
          distanceJobsTotal.inc({ status: "failed" });

          app.log.error(
            { jobId: job.id, sessionId, executionTimeMs, error: message },
            "Distance worker: job failed",
          );

          throw error;
        } finally {
          span.end();
        }
      });
    },
    {
      connection: redisConnectionOptions,
      concurrency: env.WORKER_CONCURRENCY,
      // lockDuration: maximum time (ms) a worker holds a job's lock before
      // BullMQ considers it stalled and moves it back to the wait queue.
      //
      // 30 000 ms (30 s) is chosen to be safely above the longest realistic
      // job runtime: MAX_POINTS_PER_SESSION (50 000) ÷ CHUNK_SIZE (1 000)
      // = 50 DB round-trips × ~200 ms each ≈ 10 s, plus Haversine computation
      // with setImmediate yields.  30 s gives 3× headroom without masking
      // genuinely stuck jobs (e.g. a hung DB connection).
      //
      // NOTE: BullMQ v5 does not support a per-job `timeout` in
      // defaultJobOptions — lockDuration on the Worker is the correct
      // mechanism for bounding job execution time in this version.
      lockDuration: 30_000,
      // Limit the number of completed/failed job records retained in Redis to
      // prevent unbounded memory growth over time.
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  );

  worker.on("error", (err: Error) => {
    app.log.error({ err }, "Distance worker: uncaught worker error");
  });

  // Fired by BullMQ only after ALL retry attempts are exhausted.
  // At this point the job will not be retried, so we permanently mark the
  // session status as 'failed' so operators and crash recovery can identify it.
  worker.on("failed", (job: Job<DistanceJobData> | undefined, err: Error) => {
    app.log.error(
      { jobId: job?.id, sessionId: job?.data.sessionId, err },
      "Distance worker: job permanently failed after all retries",
    );

    const failedSessionId = job?.data.sessionId;
    if (failedSessionId) {
      if (job?.data) {
        moveDistanceToDeadLetter(job.data, err.message)
          .then(() => {
            app.log.warn(
              {
                jobId: job.id,
                sessionId: failedSessionId,
                queue: "distance-failed",
                reason: err.message,
                timestamp: new Date().toISOString(),
              },
              "Distance worker: moved failed job to dead letter queue",
            );
          })
          .catch((dlqErr: unknown) => {
            app.log.error(
              { jobId: job.id, sessionId: failedSessionId, dlqErr },
              "Distance worker: failed to move job to dead letter queue",
            );
          });
      }

      void (async () => {
        const { error } = await supabase
          .from("attendance_sessions")
          .update({ distance_recalculation_status: "failed" })
          .eq("id", failedSessionId);
        if (error) {
          app.log.error(
            { sessionId: failedSessionId, error },
            "Distance worker: failed to update recalculation status to 'failed'",
          );
        }
      })();
    }
  });

  app.log.info(
    { concurrency: env.WORKER_CONCURRENCY },
    "Phase 10: BullMQ distance worker started",
  );

  return worker;
}

// ─── Crash Recovery ───────────────────────────────────────────────────────────

export async function performStartupRecovery(
  fastifyApp: FastifyInstance,
): Promise<void> {
  try {
    fastifyApp.log.info("Phase 10: starting crash recovery scan");

    const { attendanceRepository } =
      await import("../modules/attendance/attendance.repository.js");

    const orphans =
      await attendanceRepository.findSessionsNeedingRecalculation(
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
