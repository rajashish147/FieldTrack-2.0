/**
 * webhook-event.service.ts — Domain event → webhook delivery fan-out.
 *
 * This service has two responsibilities:
 *
 *  1. PERSISTENCE: When a domain event is emitted and WORKERS_ENABLED=true,
 *     insert a row into webhook_events so there is a permanent, queryable
 *     audit trail of every event regardless of webhook registration status.
 *
 *  2. FAN-OUT: Find all active webhooks for the event's org that subscribe to
 *     the event type, create a webhook_delivery row for each, and enqueue a
 *     BullMQ delivery job.
 *
 * Wiring happens in webhook.worker.ts (subscribeToEventBus()), which calls
 * registerWebhookListener() once per event name at startup.
 *
 * Safety contracts:
 *  - This module MUST NOT throw into the event bus — all errors are caught
 *    and logged so a database or Redis failure never crashes the emitting
 *    request lifecycle.
 *  - No synchronous HTTP calls — delivery is always async via BullMQ.
 *  - worker-only: the listener is only registered when shouldStartWorkers()
 *    returns true (WORKERS_ENABLED=true AND not in test env).
 */

import type { FastifyBaseLogger } from "fastify";
import { supabaseServiceClient as supabase } from "../config/supabase.js";
import { eventBus, type EventName, type EventEnvelope } from "../utils/event-bus.js";
import {
  enqueueWebhookDelivery,
  WEBHOOK_RETRY_DELAYS_MS,
  type WebhookDeliveryJobData,
} from "./webhook.queue.js";

// ─── DB row shapes (subset) ───────────────────────────────────────────────────

interface WebhookRow {
  id: string;
  url: string;
  secret: string;
}

// ─── Core fan-out logic ───────────────────────────────────────────────────────

/**
 * Process a domain event envelope:
 *  1. Persist it in webhook_events.
 *  2. Fan out to matching active webhooks.
 */
export async function processEventForWebhooks<T extends EventName>(
  envelope: EventEnvelope<T>,
  log: FastifyBaseLogger,
): Promise<void> {
  const { id: eventId, type, organization_id: orgId } = envelope;

  // ── 1. Persist the event ──────────────────────────────────────────────────
  const { data: eventRow, error: insertError } = await supabase
    .from("webhook_events")
    .insert({
      id:              eventId,
      organization_id: orgId,
      event_type:      type,
      payload:         envelope as unknown as Record<string, unknown>,
    })
    .select("id")
    .single();

  if (insertError) {
    log.error(
      { eventId, eventType: type, orgId, error: insertError.message },
      "webhook-event.service: failed to persist webhook_event",
    );
    // Do not abort — we still attempt fan-out even if persistence failed,
    // so active webhooks receive the event. The missing audit row is an
    // observability gap, not a correctness failure.
  }

  const persistedEventId = eventRow?.id ?? eventId;

  // ── 2. Find matching active webhooks ──────────────────────────────────────
  const { data: webhooks, error: fetchError } = await supabase
    .from("webhooks")
    .select("id, url, secret")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .contains("events", [type]);

  if (fetchError) {
    log.error(
      { eventId, eventType: type, orgId, error: fetchError.message },
      "webhook-event.service: failed to fetch matching webhooks",
    );
    return;
  }

  if (!webhooks || webhooks.length === 0) {
    log.debug(
      { eventId, eventType: type, orgId },
      "webhook-event.service: no matching webhooks, skipping fan-out",
    );
    return;
  }

  log.info(
    { eventId, eventType: type, orgId, webhookCount: webhooks.length },
    "webhook-event.service: fanning out to webhooks",
  );

  // ── 3. Create delivery rows and enqueue jobs ──────────────────────────────
  await Promise.allSettled(
    (webhooks as WebhookRow[]).map((webhook) =>
      createAndEnqueueDelivery(persistedEventId, webhook, orgId, type, log),
    ),
  );
}

async function createAndEnqueueDelivery(
  eventId: string,
  webhook: WebhookRow,
  orgId: string,
  eventType: string,
  log: FastifyBaseLogger,
): Promise<void> {
  // Insert the delivery row — ON CONFLICT DO NOTHING ensures idempotency
  // if the fan-out function is called more than once for the same event
  // (e.g. due to a process restart mid-flight).
  const { data: delivery, error: deliveryInsertError } = await supabase
    .from("webhook_deliveries")
    .insert({
      webhook_id:      webhook.id,
      event_id:        eventId,
      organization_id: orgId,
      status:          "pending",
      attempt_count:   0,
    })
    .select("id")
    .single();

  if (deliveryInsertError) {
    // Unique constraint violation = already created. Log and skip.
    if (deliveryInsertError.code === "23505") {
      log.debug(
        { eventId, webhookId: webhook.id },
        "webhook-event.service: delivery already exists, skipping duplicate",
      );
      return;
    }
    log.error(
      { eventId, webhookId: webhook.id, error: deliveryInsertError.message },
      "webhook-event.service: failed to create delivery row",
    );
    return;
  }

  if (!delivery) {
    log.error(
      { eventId, webhookId: webhook.id },
      "webhook-event.service: delivery insert returned no data",
    );
    return;
  }

  const jobData: WebhookDeliveryJobData = {
    delivery_id:    delivery.id,
    webhook_id:     webhook.id,
    event_id:       eventId,
    url:            webhook.url,
    secret:         webhook.secret,
    attempt_number: 1,
  };

  try {
    log.info(
      { deliveryId: delivery.id, webhookId: webhook.id, eventType, orgId },
      "webhook-event.service: adding job to queue",
    );
    await enqueueWebhookDelivery(jobData, WEBHOOK_RETRY_DELAYS_MS[0]);
    log.info(
      { deliveryId: delivery.id, webhookId: webhook.id, eventType, orgId },
      "webhook-event.service: job added to queue",
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { deliveryId: delivery.id, webhookId: webhook.id, error: message },
      "webhook-event.service: failed to enqueue delivery job",
    );
    // Mark delivery as failed so the admin UI shows the issue.
    await supabase
      .from("webhook_deliveries")
      .update({
        status:         "failed",
        response_body:  `Enqueue error: ${message}`,
        last_attempt_at: new Date().toISOString(),
      })
      .eq("id", delivery.id)
      .then(() => undefined); // fire-and-forget
  }
}

// ─── Event bus subscription ───────────────────────────────────────────────────

const EVENT_NAMES: ReadonlyArray<EventName> = [
  "employee.checked_in",
  "employee.checked_out",
  "expense.created",
  "expense.approved",
  "expense.rejected",
  "employee.created",
];

/**
 * Subscribe to all known domain events and route them through
 * processEventForWebhooks().
 *
 * Called once at worker startup (webhook.worker.ts → startWebhookWorker()).
 * Must NOT be called in test environments or when WORKERS_ENABLED=false.
 */
export function subscribeToEventBus(log: FastifyBaseLogger): void {
  for (const eventName of EVENT_NAMES) {
    eventBus.on(eventName, (envelope) => {
      processEventForWebhooks(envelope, log).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { event: eventName, error: message },
          "webhook-event.service: unhandled error in event fan-out",
        );
      });
    });
  }

  log.info(
    { events: EVENT_NAMES },
    "webhook-event.service: subscribed to domain event bus",
  );
}
