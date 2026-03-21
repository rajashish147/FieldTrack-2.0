import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { supabaseServiceClient as supabase } from "../config/supabase.js";
import { enqueueDistanceJob } from "./distance.queue.js";
import { enqueueAnalyticsJob } from "./analytics.queue.js";
import { retryIntentCreatedTotal } from "../plugins/prometheus.js";

type QueueName = "distance-engine" | "analytics";

interface RetryIntentPayload {
  sessionId: string;
  organizationId?: string;
  employeeId?: string;
}

interface RetryIntentRow {
  id: string;
  queue_name: QueueName;
  job_key: string;
  payload: RetryIntentPayload;
  retry_count: number;
}

const RETRY_BASE_DELAY_SECONDS = 5;
const RETRY_MAX_DELAY_SECONDS = 300;
const RETRY_MAX_ATTEMPTS = 8;

function nextRetryIso(retryCount: number): string {
  const backoffSeconds = Math.min(
    RETRY_MAX_DELAY_SECONDS,
    RETRY_BASE_DELAY_SECONDS * (2 ** Math.max(0, retryCount - 1)),
  );
  return new Date(Date.now() + backoffSeconds * 1000).toISOString();
}

export async function persistRetryIntent(
  queueName: QueueName,
  jobKey: string,
  payload: RetryIntentPayload,
  reason: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const { error } = await supabase
    .from("queue_retry_intents")
    .upsert(
      {
        queue_name: queueName,
        job_key: jobKey,
        payload,
        status: "pending",
        error_message: reason,
        next_retry_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "queue_name,job_key" },
    );

  if (error) {
    log.error(
      { queueName, jobKey, reason, error: error.message, timestamp: new Date().toISOString() },
      "Failed to persist queue retry intent",
    );
    return;
  }

  // Increment Prometheus counter for spike detection
  retryIntentCreatedTotal.inc();

  // Alert hook: log at warn level if spike is detected
  // (spike = persistence happens during operations, indicates transient failures)
  log.warn(
    {
      event: "RETRY_INTENT_PERSISTED",
      severity: "warn",
      queueName,
      jobKey,
      reason,
      timestamp: new Date().toISOString(),
    },
    "Persisted queue retry intent — enqueue failed, retry scheduled",
  );
}

async function markIntentResolved(id: string): Promise<void> {
  await supabase
    .from("queue_retry_intents")
    .update({ status: "resolved", updated_at: new Date().toISOString() })
    .eq("id", id);
}

async function markIntentRetry(id: string, retryCount: number, reason: string): Promise<"retry" | "dead"> {
  const nextAttempt = retryCount + 1;
  if (nextAttempt >= RETRY_MAX_ATTEMPTS) {
    await supabase
      .from("queue_retry_intents")
      .update({
        status: "dead",
        retry_count: nextAttempt,
        next_retry_at: new Date().toISOString(),
        error_message: reason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    return "dead";
  }

  await supabase
    .from("queue_retry_intents")
    .update({
      retry_count: nextAttempt,
      next_retry_at: nextRetryIso(nextAttempt),
      error_message: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  return "retry";
}

export async function replayPendingRetryIntents(
  app: FastifyInstance,
  limit = 100,
): Promise<void> {
  const { data, error } = await supabase
    .from("queue_retry_intents")
    .select("id, queue_name, job_key, payload, retry_count")
    .eq("status", "pending")
    .lte("next_retry_at", new Date().toISOString())
    .order("next_retry_at", { ascending: true })
    .limit(limit);

  if (error) {
    app.log.error({ error: error.message }, "Failed to load queue retry intents");
    return;
  }

  const intents = (data ?? []) as RetryIntentRow[];
  if (intents.length === 0) {
    return;
  }

  app.log.info({ count: intents.length }, "Replaying pending queue retry intents");

  for (const intent of intents) {
    try {
      if (intent.queue_name === "distance-engine") {
        await enqueueDistanceJob(intent.payload.sessionId);
      } else {
        if (!intent.payload.organizationId || !intent.payload.employeeId) {
          throw new Error("Missing organizationId or employeeId for analytics retry intent");
        }
        await enqueueAnalyticsJob(
          intent.payload.sessionId,
          intent.payload.organizationId,
          intent.payload.employeeId,
        );
      }
      await markIntentResolved(intent.id);
      app.log.info(
        {
          intentId: intent.id,
          queueName: intent.queue_name,
          jobKey: intent.job_key,
          attempt: intent.retry_count + 1,
          timestamp: new Date().toISOString(),
        },
        "Retry intent replay succeeded",
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const action = await markIntentRetry(intent.id, intent.retry_count, message);
      app.log.warn(
        {
          intentId: intent.id,
          queueName: intent.queue_name,
          jobKey: intent.job_key,
          attempt: intent.retry_count + 1,
          maxAttempts: RETRY_MAX_ATTEMPTS,
          action,
          error: message,
          timestamp: new Date().toISOString(),
        },
        "Retry intent replay failed",
      );
    }
  }
}

export async function cleanupResolvedRetryIntents(
  app: FastifyInstance,
  retainHours = 72,
): Promise<number> {
  const cutoff = new Date(Date.now() - retainHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("queue_retry_intents")
    .delete()
    .in("status", ["resolved", "dead"])
    .lt("created_at", cutoff)
    .select("id");

  if (error) {
    app.log.error(
      { error: error.message, retainHours, cutoff, timestamp: new Date().toISOString() },
      "Retry intent cleanup failed",
    );
    return 0;
  }

  const deleted = data?.length ?? 0;
  app.log.info(
    { deleted, retainHours, cutoff, timestamp: new Date().toISOString() },
    "Retry intent cleanup completed",
  );
  return deleted;
}
