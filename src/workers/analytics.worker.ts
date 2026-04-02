import { Worker } from "bullmq";
import type { Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import { redisConnectionOptions } from "../config/redis.js";
import { env } from "../config/env.js";
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
 *  4. Update org_dashboard_snapshot (Step 3.5 — inserted before cache invalidation).
 *  5. Invalidate the org analytics cache so dashboards pick up fresh data.
 *
 * Idempotency guarantee:
 *  Running the job N times always produces the same result because every run
 *  recomputes from the source data — there is no per-run counter.  This means
 *  retries, duplicate enqueues, and manual replays are all safe.
 */

/**
 * Compute and UPSERT the org_dashboard_snapshot row for `organizationId`.
 *
 * Always reads current state — not session-date-scoped — so running on a
 * historical session still leaves the snapshot with up-to-date figures.
 *
 * Errors are logged but NOT re-thrown so a snapshot failure never causes a
 * checkout job to be marked failed.
 */
async function updateDashboardSnapshot(
  organizationId: string,
  app: FastifyInstance,
): Promise<void> {
  try {
    const today = new Date().toISOString().substring(0, 10);

    // Three queries run in parallel — none block each other.
    const [empStatusResult, todayMetricsResult, pendingExpResult] =
      await Promise.all([
        supabase
          .from("employee_latest_sessions")
          .select("status")
          .eq("organization_id", organizationId),

        supabase
          .from("org_daily_metrics")
          .select("total_sessions, total_distance_km")
          .eq("organization_id", organizationId)
          .eq("date", today)
          .maybeSingle(),

        supabase
          .from("expenses")
          .select("amount")
          .eq("organization_id", organizationId)
          .eq("status", "PENDING"),
      ]);

    if (empStatusResult.error) {
      app.log.warn(
        { organizationId, error: empStatusResult.error.message },
        "Analytics worker: dashboard snapshot — employee_latest_sessions query failed",
      );
      return;
    }
    if (pendingExpResult.error) {
      app.log.warn(
        { organizationId, error: pendingExpResult.error.message },
        "Analytics worker: dashboard snapshot — expenses query failed",
      );
      return;
    }

    const empRows = (empStatusResult.data ?? []) as Array<{ status: string | null }>;
    const activeCount = empRows.filter((r) => r.status === "ACTIVE").length;
    const recentCount = empRows.filter((r) => r.status === "RECENT").length;
    const inactiveCount = empRows.length - activeCount - recentCount;

    const todayRow = todayMetricsResult.data as {
      total_sessions: number;
      total_distance_km: number;
    } | null;

    const pendingRows = (pendingExpResult.data ?? []) as Array<{ amount: number }>;
    const pendingExpenseCount = pendingRows.length;
    const pendingExpenseAmount =
      Math.round(
        pendingRows.reduce((sum, e) => sum + Number(e.amount), 0) * 100,
      ) / 100;

    const { error: upsertErr } = await supabase
      .from("org_dashboard_snapshot")
      .upsert(
        {
          organization_id: organizationId,
          active_employee_count: activeCount,
          recent_employee_count: recentCount,
          inactive_employee_count: inactiveCount,
          active_employees_today: activeCount,
          today_session_count: todayRow?.total_sessions ?? 0,
          today_distance_km:
            Math.round((todayRow?.total_distance_km ?? 0) * 100) / 100,
          pending_expense_count: pendingExpenseCount,
          pending_expense_amount: pendingExpenseAmount,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id" },
      );

    if (upsertErr) {
      app.log.warn(
        { organizationId, error: upsertErr.message },
        "Analytics worker: dashboard snapshot upsert failed",
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    app.log.warn(
      { organizationId, error: message },
      "Analytics worker: dashboard snapshot update threw unexpectedly",
    );
  }
}

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

  // ── Step 3.5: Update org_dashboard_snapshot ───────────────────────────────
  //
  // Runs after org_daily_metrics is committed so today's session/distance
  // figures are already accurate when we snapshot them.
  //
  // Three independent sub-queries run in parallel:
  //   a) employee status counts from employee_latest_sessions (O(org_employees))
  //   b) today's session/distance from org_daily_metrics (1 row by PK)
  //   c) pending expense count + amount from expenses (filtered by status)
  //
  // Errors here are non-fatal: a failed snapshot leaves the dashboard reading
  // slightly stale data — far better than failing a checkout job entirely.

  await updateDashboardSnapshot(organizationId, app);

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
      concurrency: env.ANALYTICS_WORKER_CONCURRENCY,
      // lockDuration: maximum time (ms) a worker holds a job's lock before
      // BullMQ considers it stalled and moves it back to the wait queue.
      //
      // 30 000 ms (30 s) is well above the longest realistic analytics job:
      // ~7 DB queries × ~200 ms each ≈ 1.4 s typical; 30 s gives 20× headroom
      // without masking genuinely stuck jobs (e.g. a hung DB connection or
      // an infinite retry loop on a non-convergent session).
      //
      // NOTE: BullMQ v5 does not support a per-job `timeout` in
      // defaultJobOptions — lockDuration on the Worker is the correct
      // mechanism for bounding job execution time in this version.
      lockDuration: 30_000,
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
    { concurrency: env.ANALYTICS_WORKER_CONCURRENCY },
    "Phase 21: BullMQ analytics worker started",
  );

  return worker;
}
