/**
 * webhook.worker.ts — BullMQ worker for async webhook delivery.
 *
 * Lifecycle per job:
 *  1. Fetch the event payload from webhook_events.
 *  2. Serialize the envelope to a stable JSON string.
 *  3. Generate timestamp-bound HMAC-SHA256 signature over `timestamp.raw_body`.
 *  4. Reject payloads above WEBHOOK_MAX_PAYLOAD_BYTES (move to DLQ).
 *  4. POST to the webhook URL with a 5 s timeout.
 *  5. On success → mark delivery as `success`.
 *  6. On failure → schedule a retry (exponential delays) up to MAX_ATTEMPTS.
 *     After max attempts → mark delivery as `failed`.
 *
 * Security:
 *  - DNS rebinding defence: The hostname is resolved immediately before the
 *    HTTP request and checked against private IP ranges.
 *  - Request timeout enforced at 5 s.
 *  - Signature is HMAC-SHA256(secret, `${timestamp}.${rawBody}`), header: X-FieldTrack-Signature.
 *
 * Worker gate: `startWebhookWorker()` is only called when
 * `shouldStartWorkers()` returns true (WORKERS_ENABLED=true AND not test env).
 */

import { Worker } from "bullmq";
import type { Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import dns from "node:dns/promises";
import { Redis } from "ioredis";
import { redisConnectionOptions, getRedisConnectionOptions } from "../config/redis.js";
import { supabaseServiceClient as supabase } from "../config/supabase.js";
import { generateSignatureWithTimestamp } from "../utils/hmac.js";
import { subscribeToEventBus } from "./webhook-event.service.js";
import {
  WEBHOOK_QUEUE_NAME,
  WEBHOOK_MAX_ATTEMPTS,
  enqueueWebhookDelivery,
  enqueueToDlq,
  calculateRetryDelay,
  startDlqPurgeInterval,
  type WebhookDeliveryJobData,
} from "./webhook.queue.js";
import {
  recordDeliverySuccess,
  recordDeliveryFailure,
  startCircuitRecoveryInterval,
} from "./circuit-breaker.js";
import {
  webhookDeliveriesTotal,
  webhookFailuresTotal,
  webhookRetriesTotal,
} from "../plugins/prometheus.js";
import { env } from "../config/env.js";

// ─── Metrics helpers ──────────────────────────────────────────────────────────

/**
 * Map a raw event_type string to a bounded Prometheus label value.
 *
 * Prometheus label cardinality must stay bounded.  Event types arrive from
 * the DB payload and could theoretically be any string (e.g. from a future
 * schema migration, a bug, or a bad INSERT).  Mapping unknowns to "other"
 * keeps the label set finite and prevents cardinality explosion.
 *
 * Update this set whenever a new EventDataMap key is added to event-bus.ts.
 */
const KNOWN_EVENT_TYPES = new Set<string>([
  "employee.checked_in",
  "employee.checked_out",
  "expense.created",
  "expense.approved",
  "expense.rejected",
  "employee.created",
]);

function normalizeEventType(raw: string | undefined): string {
  if (!raw) return "unknown";
  return KNOWN_EVENT_TYPES.has(raw) ? raw : "other";
}

// ─── Shared Redis client for circuit-breaker streak counters ──────────────────
// Lazy-created so tests that never call startWebhookWorker() pay zero cost.
let _cbRedis: Redis | undefined;
function getCbRedis(): Redis {
  if (!_cbRedis) {
    _cbRedis = new Redis(getRedisConnectionOptions());
    _cbRedis.on("error", () => {
      // Swallow — circuit-breaker Redis errors are non-fatal (delivery still proceeds)
    });
  }
  return _cbRedis;
}

// ─── Private IP ranges (DNS rebinding defence) ───────────────────────────────

const PRIVATE_IP_PATTERNS: ReadonlyArray<RegExp> = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fe80:/i,
  /^0\.0\.0\.0$/,
];

function isPrivateAddress(ip: string): boolean {
  const lower = ip.toLowerCase();
  return PRIVATE_IP_PATTERNS.some((re) => re.test(lower));
}

// ─── HTTP delivery ────────────────────────────────────────────────────────────

const DELIVERY_TIMEOUT_MS = 5_000;
const WEBHOOK_PAYLOAD_MAX_BYTES = env.WEBHOOK_MAX_PAYLOAD_BYTES;

/**
 * Perform one HTTP delivery attempt.
 *
 * Returns `{ status: number; body: string }` on any completed response
 * (including 4xx/5xx — those are caller's problem to interpret).
 *
 * Throws on network error, timeout, or SSRF block.
 */
async function deliverWebhook(
  url: string,
  rawBody: string,
  signature: string,
  eventType: string,
  timestamp: number,
  deliveryId: string,
): Promise<{ status: number; body: string }> {
  // ── DNS rebinding defence ──────────────────────────────────────────────────
  const parsed = new URL(url);
  let resolvedAddress: string;
  try {
    const { address } = await dns.lookup(parsed.hostname, { family: 4 });
    resolvedAddress = address;
  } catch {
    // IPv6 fallback
    try {
      const { address } = await dns.lookup(parsed.hostname, { family: 6 });
      resolvedAddress = address;
    } catch {
      throw new Error(`DNS lookup failed for hostname: ${parsed.hostname}`);
    }
  }

  if (isPrivateAddress(resolvedAddress)) {
    throw new Error(
      `SSRF blocked: ${parsed.hostname} resolved to private address ${resolvedAddress}`,
    );
  }

  // ── HTTP POST with timeout ─────────────────────────────────────────────────
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    DELIVERY_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":               "application/json",
        "X-FieldTrack-Signature":     signature,
        "X-FieldTrack-Event":         eventType,
        "X-FieldTrack-Timestamp":     String(timestamp),
        "X-FieldTrack-Delivery-Id":   deliveryId,
        "User-Agent":                 "FieldTrack-Webhooks/1.0",
      },
      body: rawBody,
      // Never follow redirects — a redirect could point to an internal address
      // that bypassed the SSRF DNS check performed above.
      redirect: "error",
      signal: controller.signal,
    });

    const body = await response.text().catch(() => "");
    return { status: response.status, body: body.slice(0, 4_096) };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ─── Delivery result handler ──────────────────────────────────────────────────

/**
 * Mark a delivery row as succeeded in the database.
 */
async function markSuccess(
  deliveryId: string,
  responseStatus: number,
  responseBody: string,
): Promise<void> {
  await supabase
    .from("webhook_deliveries")
    .update({
      status:          "success",
      response_status:  responseStatus,
      response_body:    responseBody,
      last_attempt_at:  new Date().toISOString(),
    })
    .eq("id", deliveryId);
}

/**
 * Increment attempt count, record response, and schedule the next retry.
 * If max attempts reached, marks status as `failed`.
 */
async function scheduleRetryOrFail(
  deliveryId: string,
  webhook_id: string,
  event_id: string,
  url: string,
  secret: string,
  attemptNumber: number,
  responseStatus: number | null,
  responseBody: string,
  app: FastifyInstance,
): Promise<void> {
  const nextAttempt = attemptNumber + 1;
  const canRetry = nextAttempt <= WEBHOOK_MAX_ATTEMPTS;
  const delayMs = canRetry ? calculateRetryDelay(nextAttempt) : 0;
  const nextRetryAt = canRetry
    ? new Date(Date.now() + delayMs).toISOString()
    : null;

  await supabase
    .from("webhook_deliveries")
    .update({
      status:           canRetry ? "pending" : "failed",
      attempt_count:     attemptNumber,
      response_status:   responseStatus,
      response_body:     responseBody.slice(0, 4_096),
      last_attempt_at:   new Date().toISOString(),
      next_retry_at:     nextRetryAt,
    })
    .eq("id", deliveryId);

  if (canRetry) {
    try {
      await enqueueWebhookDelivery(
        {
          delivery_id:    deliveryId,
          webhook_id,
          event_id,
          url,
          secret,
          attempt_number: nextAttempt,
        },
        delayMs,
      );
      app.log.info(
        { deliveryId, webhookId: webhook_id, attemptNumber, nextAttempt, delayMs },
        "webhook.worker: scheduled retry with jitter",
      );
    } catch (enqueueErr: unknown) {
      const msg = enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr);
      app.log.error(
        { deliveryId, webhookId: webhook_id, error: msg },
        "webhook.worker: failed to enqueue retry — delivery marked failed",
      );
      // Cannot retry — mark as failed to avoid phantom pending records.
      await supabase
        .from("webhook_deliveries")
        .update({ status: "failed" })
        .eq("id", deliveryId);
    }
  } else {
    app.log.warn(
      { deliveryId, webhookId: webhook_id, attemptNumber },
      "webhook.worker: max attempts reached, moving delivery to DLQ",
    );
    // Move to Dead-Letter Queue so the delivery remains visible to admins.
    try {
      await enqueueToDlq({
        delivery_id:    deliveryId,
        webhook_id,
        event_id,
        url,
        secret,
        attempt_number: attemptNumber,
      });
    } catch (dlqErr: unknown) {
      const msg = dlqErr instanceof Error ? dlqErr.message : String(dlqErr);
      app.log.error(
        { deliveryId, webhookId: webhook_id, error: msg },
        "webhook.worker: failed to enqueue to DLQ — delivery already marked failed in DB",
      );
    }
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

let workerStarted = false;

export function startWebhookWorker(app: FastifyInstance): Worker | null {
  if (workerStarted) {
    app.log.warn("startWebhookWorker called more than once — ignoring duplicate start");
    return null;
  }

  workerStarted = true;

  // Subscribe to the in-process event bus so domain events are persisted and
  // fanned out to registered webhooks as soon as they are emitted.
  subscribeToEventBus(app.log);

  const worker = new Worker<WebhookDeliveryJobData>(
    WEBHOOK_QUEUE_NAME,
    async (job: Job<WebhookDeliveryJobData>): Promise<void> => {
      const { delivery_id, webhook_id, event_id, url, secret, attempt_number } =
        job.data;

      app.log.info(
        { deliveryId: delivery_id, webhookId: webhook_id, attemptNumber: attempt_number },
        "webhook.worker: processing delivery job",
      );

      // ── Idempotency guard ────────────────────────────────────────────────
      // Verify the delivery row is still in `pending` state before proceeding.
      // Prevents duplicate delivery if BullMQ re-delivers a job (e.g. after an
      // ungraceful shutdown) or an admin manually retried while a queued job
      // was already in flight.
      const { data: deliveryCheck } = await supabase
        .from("webhook_deliveries")
        .select("status")
        .eq("id", delivery_id)
        .single();

      if (deliveryCheck && deliveryCheck.status === "success") {
        app.log.info(
          { deliveryId: delivery_id, webhookId: webhook_id },
          "webhook.worker: delivery already succeeded \u2014 skipping duplicate job",
        );
        return;
      }

      // ── Fetch event payload ──────────────────────────────────────────────
      const { data: eventRow, error: fetchError } = await supabase
        .from("webhook_events")
        .select("payload")
        .eq("id", event_id)
        .single();

      if (fetchError || !eventRow) {
        app.log.error(
          { eventId: event_id, error: fetchError?.message },
          "webhook.worker: cannot fetch event payload — marking delivery failed",
        );
        await supabase
          .from("webhook_deliveries")
          .update({
            status:          "failed",
            response_body:    "Event payload not found",
            last_attempt_at:  new Date().toISOString(),
          })
          .eq("id", delivery_id);
        return;
      }

      // ── Build and sign the request body ───────────────────────────────────
      const rawBody = JSON.stringify(eventRow.payload);
      const { signature, timestamp: deliveryTs } = generateSignatureWithTimestamp(secret, rawBody);
      // Extract the event type from the envelope payload for the request header.
      // The payload is the full EventEnvelope which always carries a `type` field.
      const eventType =
        (eventRow.payload as Record<string, unknown>).type as string | undefined
        ?? "webhook-delivery";

      const payloadBytes = Buffer.byteLength(rawBody, "utf8");
      if (payloadBytes > WEBHOOK_PAYLOAD_MAX_BYTES) {
        const message =
          `Payload size ${payloadBytes} bytes exceeds cap ${WEBHOOK_PAYLOAD_MAX_BYTES} bytes`;
        app.log.error(
          {
            deliveryId: delivery_id,
            webhookId: webhook_id,
            eventId: event_id,
            payloadBytes,
            maxBytes: WEBHOOK_PAYLOAD_MAX_BYTES,
          },
          "webhook.worker: payload exceeds size cap, marking failed",
        );

        await supabase
          .from("webhook_deliveries")
          .update({
            status: "failed",
            attempt_count: attempt_number,
            response_body: message,
            last_attempt_at: new Date().toISOString(),
            next_retry_at: null,
          })
          .eq("id", delivery_id);

        webhookDeliveriesTotal
          .labels({ event_type: normalizeEventType(eventType), status: "failed" })
          .inc();
        webhookFailuresTotal
          .labels({ event_type: normalizeEventType(eventType) })
          .inc();

        try {
          await enqueueToDlq({
            delivery_id,
            webhook_id,
            event_id,
            url,
            secret,
            attempt_number,
          });
        } catch (dlqErr: unknown) {
          app.log.error(
            {
              deliveryId: delivery_id,
              webhookId: webhook_id,
              error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
            },
            "webhook.worker: failed to enqueue oversize payload delivery to DLQ",
          );
        }
        return;
      }

      // ── Deliver ───────────────────────────────────────────────────────────
      try {
        const { status, body } = await deliverWebhook(url, rawBody, signature, eventType, deliveryTs, delivery_id);
        const succeeded = status >= 200 && status < 300;

        if (succeeded) {
          await markSuccess(delivery_id, status, body);
          await recordDeliverySuccess(webhook_id, getCbRedis(), app.log);
          webhookDeliveriesTotal
            .labels({ event_type: normalizeEventType(eventType), status: "success" })
            .inc();
          app.log.info(
            { deliveryId: delivery_id, webhookId: webhook_id, responseStatus: status },
            "webhook.worker: delivery succeeded",
          );
        } else {
          const willRetry = attempt_number + 1 <= WEBHOOK_MAX_ATTEMPTS;
          app.log.warn(
            {
              deliveryId: delivery_id,
              webhookId: webhook_id,
              responseStatus: status,
              attemptNumber: attempt_number,
            },
            "webhook.worker: delivery got non-2xx response, scheduling retry",
          );
          await recordDeliveryFailure(webhook_id, getCbRedis(), app.log);
          webhookDeliveriesTotal
            .labels({ event_type: normalizeEventType(eventType), status: "failed" })
            .inc();
          if (willRetry) {
            webhookRetriesTotal
              .labels({ event_type: normalizeEventType(eventType) })
              .inc();
          } else {
            webhookFailuresTotal
              .labels({ event_type: normalizeEventType(eventType) })
              .inc();
          }
          await scheduleRetryOrFail(
            delivery_id,
            webhook_id,
            event_id,
            url,
            secret,
            attempt_number,
            status,
            body,
            app,
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const willRetry = attempt_number + 1 <= WEBHOOK_MAX_ATTEMPTS;
        app.log.error(
          {
            deliveryId: delivery_id,
            webhookId: webhook_id,
            attemptNumber: attempt_number,
            error: message,
          },
          "webhook.worker: delivery attempt threw error, scheduling retry",
        );
        await recordDeliveryFailure(webhook_id, getCbRedis(), app.log);
        webhookDeliveriesTotal
          .labels({ event_type: normalizeEventType(eventType), status: "error" })
          .inc();
        if (willRetry) {
          webhookRetriesTotal
            .labels({ event_type: normalizeEventType(eventType) })
            .inc();
        } else {
          webhookFailuresTotal
            .labels({ event_type: normalizeEventType(eventType) })
            .inc();
        }
        await scheduleRetryOrFail(
          delivery_id,
          webhook_id,
          event_id,
          url,
          secret,
          attempt_number,
          null,
          message,
          app,
        );
      }
    },
    {
      connection: redisConnectionOptions,
      concurrency: env.WEBHOOK_WORKER_CONCURRENCY,
      lockDuration: 30_000,
    },
  );

  worker.on("failed", (job, err) => {
    const jobId = job?.id ?? "(unknown)";
    app.log.error(
      { jobId, error: err.message },
      "webhook.worker: BullMQ job permanently failed",
    );
  });

  // Start the hourly DLQ retention purge (archives expired jobs, enforces max size).
  startDlqPurgeInterval(app.log);
  startCircuitRecoveryInterval(getCbRedis(), app.log);

  app.log.info(
    { concurrency: env.WEBHOOK_WORKER_CONCURRENCY },
    "webhook.worker: started",
  );
  return worker;
}
