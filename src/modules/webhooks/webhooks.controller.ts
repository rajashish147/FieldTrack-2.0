/**
 * webhooks.controller.ts — HTTP handler layer for the webhooks admin API.
 *
 * Delegates all business logic to webhooksService.
 * Uses the standard ok / paginated / fail / handleError response helpers.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { webhooksService } from "./webhooks.service.js";
import {
  createWebhookBodySchema,
  updateWebhookBodySchema,
  deliveryListQuerySchema,
} from "./webhooks.schema.js";
import { ok, paginated, handleError } from "../../utils/response.js";

export const webhooksController = {
  // ─── Webhook CRUD ──────────────────────────────────────────────────────────

  async create(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = createWebhookBodySchema.parse(request.body);
      const webhook = await webhooksService.createWebhook(request, body);
      reply.status(201).send(ok(webhook));
    } catch (error) {
      handleError(error, request, reply, "Failed to create webhook");
    }
  },

  async list(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const webhooks = await webhooksService.listWebhooks(request);
      reply.status(200).send(ok(webhooks));
    } catch (error) {
      handleError(error, request, reply, "Failed to list webhooks");
    }
  },

  async update(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const { id } = request.params;
      const body = updateWebhookBodySchema.parse(request.body);
      const webhook = await webhooksService.updateWebhook(request, id, body);
      reply.status(200).send(ok(webhook));
    } catch (error) {
      handleError(error, request, reply, "Failed to update webhook");
    }
  },

  async remove(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const { id } = request.params;
      await webhooksService.deleteWebhook(request, id);
      reply.status(204).send();
    } catch (error) {
      handleError(error, request, reply, "Failed to delete webhook");
    }
  },

  // ─── Deliveries ────────────────────────────────────────────────────────────

  async listDeliveries(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const query = deliveryListQuerySchema.parse(request.query);
      const { data, total } = await webhooksService.listDeliveries(request, query);
      reply.status(200).send(paginated(data, query.page, query.limit, total));
    } catch (error) {
      handleError(error, request, reply, "Failed to list webhook deliveries");
    }
  },

  async retryDelivery(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const { id } = request.params;
      const delivery = await webhooksService.retryDelivery(request, id);
      reply.status(200).send(ok(delivery));
    } catch (error) {
      handleError(error, request, reply, "Failed to retry delivery");
    }
  },
};
