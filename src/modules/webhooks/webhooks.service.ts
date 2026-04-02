/**
 * webhooks.service.ts — Business logic for webhook management and delivery retry.
 *
 * Rules:
 *  - URL validation (HTTPS-only, no private/loopback) is enforced before any
 *    write so invalid webhooks never reach the database.
 *  - Secret never returned to callers after creation — not even in update responses.
 *  - Manual retry re-enqueues a BullMQ job using attempt_count+1 so the
 *    existing retry delay schedule applies.
 *  - All queries are org-scoped through the repository.
 */

import type { FastifyRequest } from "fastify";
import { webhooksRepository } from "./webhooks.repository.js";
import { validateWebhookUrl, InvalidWebhookUrlError } from "../../utils/url-validator.js";
import { BadRequestError, NotFoundError, ServiceUnavailableError } from "../../utils/errors.js";
import { enqueueWebhookDelivery } from "../../workers/webhook.queue.js";
import { shouldStartWorkers } from "../../workers/startup.js";
import type {
  CreateWebhookBody,
  UpdateWebhookBody,
  WebhookPublic,
  WebhookDelivery,
  DeliveryListQuery,
  DlqListQuery,
  WebhookDlqDelivery,
} from "./webhooks.schema.js";

export const webhooksService = {
  // ─── Webhook CRUD ──────────────────────────────────────────────────────────

  async createWebhook(
    request: FastifyRequest,
    body: CreateWebhookBody,
  ): Promise<WebhookPublic> {
    try {
      validateWebhookUrl(body.url);
    } catch (err) {
      if (err instanceof InvalidWebhookUrlError) {
        throw new BadRequestError(err.message);
      }
      throw err;
    }

    return webhooksRepository.create(request, body);
  },

  async listWebhooks(request: FastifyRequest): Promise<WebhookPublic[]> {
    return webhooksRepository.list(request);
  },

  async updateWebhook(
    request: FastifyRequest,
    webhookId: string,
    body: UpdateWebhookBody,
  ): Promise<WebhookPublic> {
    const existing = await webhooksRepository.findById(request, webhookId);
    if (!existing) throw new NotFoundError("Webhook not found");

    if (body.url) {
      try {
        validateWebhookUrl(body.url);
      } catch (err) {
        if (err instanceof InvalidWebhookUrlError) {
          throw new BadRequestError(err.message);
        }
        throw err;
      }
    }

    return webhooksRepository.update(request, webhookId, body);
  },

  async deleteWebhook(
    request: FastifyRequest,
    webhookId: string,
  ): Promise<void> {
    const existing = await webhooksRepository.findById(request, webhookId);
    if (!existing) throw new NotFoundError("Webhook not found");
    return webhooksRepository.delete(request, webhookId);
  },

  // ─── Deliveries ────────────────────────────────────────────────────────────

  async listDeliveries(
    request: FastifyRequest,
    query: DeliveryListQuery,
  ): Promise<{ data: WebhookDelivery[]; total: number }> {
    return webhooksRepository.listDeliveries(request, query);
  },

  async listDlqDeliveries(
    request: FastifyRequest,
    query: DlqListQuery,
  ): Promise<{ data: WebhookDlqDelivery[]; total: number }> {
    return webhooksRepository.listDlqDeliveries(request, query);
  },

  /**
   * Manually retry a delivery.
   *
   * Resets the delivery to `pending` and enqueues a new BullMQ job.
   * The attempt_count is preserved so the existing retry schedule continues.
   * This is intended for admin-initiated retries after investigating a failure.
   *
   * @throws {NotFoundError} if the delivery doesn't belong to this org.
   * @throws {BadRequestError} if the delivery has not yet reached a terminal state.
   */
  async retryDelivery(
    request: FastifyRequest,
    deliveryId: string,
  ): Promise<WebhookDelivery> {
    const delivery = await webhooksRepository.findDeliveryById(request, deliveryId);
    if (!delivery) throw new NotFoundError("Delivery not found");

    if (!shouldStartWorkers()) {
      throw new ServiceUnavailableError(
        "Workers not enabled — webhook delivery requires WORKERS_ENABLED=true",
      );
    }

    if (delivery.status === "pending") {
      throw new BadRequestError("Delivery is already pending — retry not needed");
    }

    // Allow re-try even after max attempts — admin override
    const nextAttempt = delivery.attempt_count + 1;
    // Manual admin retries use immediate delay (no jitter for predictability)
    const delayMs = 0;

    // Fetch the webhook to get current URL + secret (may have changed since creation)
    const webhook = await webhooksRepository.findWebhookSecretById(request, delivery.webhook_id);
    if (!webhook) throw new NotFoundError("Webhook not found");

    // Reset delivery to pending
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    const updated = await webhooksRepository.resetDeliveryForRetry(request, deliveryId, nextRetryAt);

    await enqueueWebhookDelivery(
      {
        delivery_id:    deliveryId,
        webhook_id:     delivery.webhook_id,
        event_id:       delivery.event_id,
        url:            webhook.url,
        secret:         webhook.secret,
        attempt_number: nextAttempt,
      },
      delayMs,
    );

    request.log.info(
      { deliveryId, webhookId: delivery.webhook_id, nextAttempt, delayMs },
      "webhooks.service: manual retry enqueued",
    );

    return updated;
  },
};
