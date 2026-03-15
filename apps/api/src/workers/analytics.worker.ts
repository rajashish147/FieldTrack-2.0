import { Worker } from "bullmq";
import type { Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import { redisConnectionOptions } from "../config/redis.js";
import { supabaseServiceClient as supabase } from "../config/supabase.js";
import { invalidateOrgAnalytics } from "../utils/cache.js";
import {
  analyticsJobsTotal,
  analyticsJobDurationSeconds,
  analyticsJobFailuresTotal,
  analyticsJobRetriesTotal,
} from "../plugins/prometheus.js";
import type { AnalyticsJobData } from "./analytics.queue.js";
import { moveToDeadLetter } from "./analytics.queue.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SLOW_JOB_THRESHOLD_MS = 500;
const WORKER_CONCURRENCY = 5;

// ─── Worker Start Guard ───────────────────────────────────────────────────────

let workerStarted = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the ISO date string for the day after the given YYYY-MM-DD value.
 * Used to build an exclusive upper-bound for date-range queries.
 */
function nextDayISO(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().substring(0, 10);
}

// ─── Core Job Processor ───────────────────────────────────────────────────────

/**
 * Process a single analytics job.
 *
 * Strategy — full idempotent recompute:
 *
 *  1. Fetch the closed, distance-computed session from attendance_sessions.
 *     If distance is not yet available (distance worker not done), throw so
 *     BullMQ retries with exponential backoff.
 *
 *  2. For (employee_id, date): query ALL closed+finalized sessions for that
 *     employee on that day, aggregate distance + duration from scratch, then
 *     UPSERT employee_daily_metrics using SET (not increment).
 *
 *  3. For (organization_id, date): aggregate employee_daily_metrics for that
 *     day (no attendance_sessions scan), then UPSERT org_daily_metrics.
 *
 *  4. Invalidate the org analytics cache so dashboards pick up fresh data.
 *
 * Idempotency guarantee:
 *  Running the job N times always produces the same result because every run
 *  recomputes from the source data — there is no per-run counter.  This means
 *  retries, duplicate enqueues, and manual replays are all safe.
 */
export async function processAnalyticsJob(
  job: Job<AnalyticsJobData>,
  app: FastifyInstance,
): Promise<void> {
  const startedAt = Date.now();
  const { sessionId, organizationId, employeeId } = job.data;
  const jobId = job.id ?? sessionId;

  app.log.info(
    { jobId, sessionId, employeeId, organizationId, attempt: job.attemptsMade },
    "Analytics worker: picked up job",
  );

  // Phase 22: Track retries — any attempt after the first is a retry.
  // This counter drives the analytics_job_retries_total Prometheus metric used
  // on the worker health Grafana panel.
  if (job.attemptsMade > 0) {
    analyticsJobRetriesTotal.inc();
  }

  // ── Step 1: Fetch session — verify checkout + distance are available ────────

  const { data: session, error: sessionErr } = await supabase
    .from("attendance_sessions")
    .select("checkin_at, checkout_at, total_distance_km")
    .eq("id", sessionId)
    .single();

  if (sessionErr || !session) {
    throw new Error(`Analytics worker: session not found — id=${sessionId}`);
  }

  const typedSession = session as {
    checkin_at: string;
    checkout_at: string | null;
    total_distance_km: number | null;
  };

  // If the session is still open, throw to trigger a retry.
  if (typedSession.checkout_at === null) {
    throw new Error(
      `Analytics worker: session ${sessionId} is not yet closed — will retry`,
    );
  }

  // If the distance worker hasn't computed the distance yet, retry.
  // The exponential backoff (5 s → 10 s → 20 s) gives it plenty of time.
  if (typedSession.total_distance_km === null) {
    throw new Error(
      `Analytics worker: session ${sessionId} distance not yet computed — will retry`,
    );
  }

  const sessionDate = typedSession.checkin_at.substring(0, 10);
  const nextDay = nextDayISO(sessionDate);

  // ── Step 2: Recompute employee_daily_metrics for (employee_id, date) ────────
  //
  // Query ALL completed+finalized sessions for this employee on this date.
  // Only sessions with both checkout_at and total_distance_km set are included,
  // which means the distance worker has run on each of them.

  const { data: empSessions, error: empErr } = await supabase
    .from("attendance_sessions")
    .select("total_distance_km, total_duration_seconds")
    .eq("employee_id", employeeId)
    .eq("organization_id", organizationId)
    .gte("checkin_at", sessionDate)
    .lt("checkin_at", nextDay)
    .not("checkout_at", "is", null)
    .not("total_distance_km", "is", null);

  if (empErr) {
    throw new Error(
      `Analytics worker: employee sessions query failed: ${empErr.message}`,
    );
  }

  const empRows = (empSessions ?? []) as Array<{
    total_distance_km: number;
    total_duration_seconds: number | null;
  }>;

  const empSessionCount = empRows.length;
  const empDistanceKm =
    Math.round(
      empRows.reduce((sum, r) => sum + (r.total_distance_km ?? 0), 0) * 1000,
    ) / 1000;
  const empDurationSeconds = empRows.reduce(
    (sum, r) => sum + (r.total_duration_seconds ?? 0),
    0,
  );

  const { error: empUpsertErr } = await supabase
    .from("employee_daily_metrics")
    .upsert(
      {
        organization_id: organizationId,
        employee_id: employeeId,
        date: sessionDate,
        sessions: empSessionCount,
        distance_km: empDistanceKm,
        duration_seconds: empDurationSeconds,
      },
      { onConflict: "employee_id,date" },
    );

  if (empUpsertErr) {
    throw new Error(
      `Analytics worker: employee_daily_metrics upsert failed: ${empUpsertErr.message}`,
    );
  }

  // ── Step 3: Recompute org_daily_metrics by aggregating employee metrics ─────
  //
  // Summing employee_daily_metrics avoids a full attendance_sessions scan at the
  // org level. Since we just upserted the right employee row, these figures are
  // current for all employees who have completed sessions today.

  const { data: orgRows, error: orgErr } = await supabase
    .from("employee_daily_metrics")
    .select("sessions, distance_km, duration_seconds")
    .eq("organization_id", organizationId)
    .eq("date", sessionDate);

  if (orgErr) {
    throw new Error(
      `Analytics worker: org metrics aggregation query failed: ${orgErr.message}`,
    );
  }

  const typedOrgRows = (orgRows ?? []) as Array<{
    sessions: number;
    distance_km: number;
    duration_seconds: number;
  }>;

  const orgTotalSessions = typedOrgRows.reduce(
    (sum, r) => sum + (r.sessions ?? 0),
    0,
  );
  const orgTotalDistanceKm =
    Math.round(
      typedOrgRows.reduce((sum, r) => sum + (r.distance_km ?? 0), 0) * 1000,
    ) / 1000;
  const orgTotalDurationSeconds = typedOrgRows.reduce(
    (sum, r) => sum + (r.duration_seconds ?? 0),
    0,
  );

  const { error: orgUpsertErr } = await supabase
    .from("org_daily_metrics")
    .upsert(
      {
        organization_id: organizationId,
        date: sessionDate,
        total_sessions: orgTotalSessions,
        total_distance_km: orgTotalDistanceKm,
        total_duration_seconds: orgTotalDurationSeconds,
      },
      { onConflict: "organization_id,date" },
    );

  if (orgUpsertErr) {
    throw new Error(
      `Analytics worker: org_daily_metrics upsert failed: ${orgUpsertErr.message}`,
    );
  }

  // ── Step 4: Invalidate analytics caches ──────────────────────────────────

  // Fire-and-forget — cache expiry is never critical to job correctness.
  invalidateOrgAnalytics(organizationId).catch(() => undefined);

  // ── Step 5: Observability ──────────────────────────────────────────────────

  const durationMs = Date.now() - startedAt;
  const durationSeconds = durationMs / 1000;

  analyticsJobsTotal.labels("completed").inc();
  analyticsJobDurationSeconds.observe(durationSeconds);

  if (durationMs > SLOW_JOB_THRESHOLD_MS) {
    app.log.warn(
      { jobId, sessionId, organizationId, employeeId, durationMs },
      "Analytics worker: slow job",
    );
  }

  app.log.info(
    {
      jobId,
      sessionId,
      organizationId,
      employeeId,
      sessionDate,
      empSessionCount,
      empDistanceKm,
      orgTotalSessions,
      durationMs,
    },
    "Analytics worker: job completed",
  );
}

// ─── Worker ───────────────────────────────────────────────────────────────────

/**
 * Start the analytics worker — must be called once from app.ts after the server
 * is ready.  Guards against duplicate starts with a module-level flag.
 */
export function startAnalyticsWorker(app: FastifyInstance): Worker | null {
  if (workerStarted) {
    app.log.warn(
      "startAnalyticsWorker called more than once — ignoring duplicate start",
    );
    return null;
  }

  workerStarted = true;

  const worker = new Worker<AnalyticsJobData>(
    "analytics",
    (job) => processAnalyticsJob(job, app),
    {
      connection: redisConnectionOptions,
      concurrency: WORKER_CONCURRENCY,
      // Bound the retained job records in Redis to prevent unbounded growth.
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  );

  worker.on("error", (err: Error) => {
    app.log.error({ err }, "Analytics worker: uncaught worker error");
  });

  // Fired only after ALL retry attempts are exhausted — job will not be retried.
  worker.on("failed", (job: Job<AnalyticsJobData> | undefined, err: Error) => {
    analyticsJobsTotal.labels("failed").inc();
    // Phase 22: Dedicated permanent-failure counter used by the Prometheus alert rule.
    analyticsJobFailuresTotal.inc();
    app.log.error(
      { jobId: job?.id, sessionId: job?.data.sessionId, err },
      "Analytics worker: job permanently failed after all retries",
    );
    // Phase 22: Move to dead letter queue for operator review / manual replay.
    if (job?.data) {
      moveToDeadLetter(job.data, err.message).catch((dlqErr: unknown) => {
        app.log.error(
          { jobId: job.id, dlqErr },
          "Analytics worker: failed to move job to dead letter queue",
        );
      });
    }
  });

  app.log.info(
    { concurrency: WORKER_CONCURRENCY },
    "Phase 21: BullMQ analytics worker started",
  );

  return worker;
}
