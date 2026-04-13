/**
 * webhooks.routes.ts — Admin API routes for webhook management.
 *
 * All routes require ADMIN role.
 *
 * GET    /admin/webhooks                        — list webhooks (no secrets)
 * POST   /admin/webhooks                        — register a new webhook
 * PATCH  /admin/webhooks/:id                    — update url / events / active / secret
 * DELETE /admin/webhooks/:id                    — remove webhook and all deliveries
 *
 * GET    /admin/webhook-deliveries              — list delivery attempts
 * GET    /admin/webhooks/logs                    — alias for delivery logs
 * POST   /admin/webhook-deliveries/:id/retry    — manually retry a failed delivery
 * POST   /admin/webhooks/logs/:id/retry          — alias for log retry
 * POST   /admin/webhooks/:id/test                — enqueue a synthetic test delivery
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { webhooksController } from "./webhooks.controller.js";
import {
  createWebhookBodySchema,
  updateWebhookBodySchema,
  deliveryListQuerySchema,
  webhookPublicSchema,
  webhookDeliverySchema,
  webhookTestResponseSchema,
} from "./webhooks.schema.js";

const webhookResponse = z.object({
  success: z.literal(true),
  data: webhookPublicSchema,
});

const webhookListResponse = z.object({
  success: z.literal(true),
  data: z.array(webhookPublicSchema),
});

const deliveryResponse = z.object({
  success: z.literal(true),
  data: webhookDeliverySchema,
});

export async function webhooksRoutes(app: FastifyInstance): Promise<void> {
  // ─── Webhooks ──────────────────────────────────────────────────────────────

  app.get(
    "/admin/webhooks",
    {
      schema: {
        tags: ["admin", "webhooks"],
        summary: "List registered webhooks (secrets omitted)",
        response: { 200: webhookListResponse },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.list,
  );

  app.get(
    "/webhooks",
    {
      schema: {
        hide: true,
        tags: ["admin", "webhooks"],
        summary: "List registered webhooks (secrets omitted) [legacy alias]",
        response: { 200: webhookListResponse },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.list,
  );

  app.post(
    "/admin/webhooks",
    {
      schema: {
        tags: ["admin", "webhooks"],
        summary: "Register a new webhook endpoint",
        body: createWebhookBodySchema,
        response: { 201: webhookResponse },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.create,
  );

  app.post(
    "/webhooks",
    {
      schema: {
        hide: true,
        tags: ["admin", "webhooks"],
        summary: "Register a new webhook endpoint [legacy alias]",
        body: createWebhookBodySchema,
        response: { 201: webhookResponse },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.create,
  );

  app.patch<{ Params: { id: string } }>(
    "/admin/webhooks/:id",
    {
      schema: {
        tags: ["admin", "webhooks"],
        summary: "Update webhook url, events, active state, or secret",
        params: z.object({ id: z.string().uuid() }),
        body: updateWebhookBodySchema,
        response: { 200: webhookResponse },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.update,
  );

  app.patch<{ Params: { id: string } }>(
    "/webhooks/:id",
    {
      schema: {
        hide: true,
        tags: ["admin", "webhooks"],
        summary: "Update webhook url, events, active state, or secret [legacy alias]",
        params: z.object({ id: z.string().uuid() }),
        body: updateWebhookBodySchema,
        response: { 200: webhookResponse },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.update,
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/webhooks/:id",
    {
      schema: {
        tags: ["admin", "webhooks"],
        summary: "Delete a webhook and all its delivery history",
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null().describe("No content") },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.remove,
  );

  app.delete<{ Params: { id: string } }>(
    "/webhooks/:id",
    {
      schema: {
        hide: true,
        tags: ["admin", "webhooks"],
        summary: "Delete a webhook and all its delivery history [legacy alias]",
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null().describe("No content") },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.remove,
  );

  // ─── Deliveries ────────────────────────────────────────────────────────────

  app.get(
    "/admin/webhook-deliveries",
    {
      schema: {
        tags: ["admin", "webhooks"],
        summary: "List webhook delivery attempts for this organization",
        querystring: deliveryListQuerySchema,
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.listDeliveries,
  );

  app.get(
    "/admin/webhooks/logs",
    {
      schema: {
        tags: ["admin", "webhooks"],
        summary: "List webhook delivery logs for this organization",
        querystring: deliveryListQuerySchema,
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.listDeliveries,
  );

  app.get(
    "/webhooks/logs",
    {
      schema: {
        hide: true,
        tags: ["admin", "webhooks"],
        summary: "List webhook delivery logs for this organization [legacy alias]",
        querystring: deliveryListQuerySchema,
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.listDeliveries,
  );

  app.post<{ Params: { id: string } }>(
    "/admin/webhook-deliveries/:id/retry",
    {
      schema: {
        tags: ["admin", "webhooks"],
        summary: "Manually retry a failed or succeeded delivery",
        params: z.object({ id: z.string().uuid() }),
        response: { 200: deliveryResponse },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.retryDelivery,
  );

  app.post<{ Params: { id: string } }>(
    "/admin/webhooks/logs/:id/retry",
    {
      schema: {
        tags: ["admin", "webhooks"],
        summary: "Retry a webhook delivery log entry",
        params: z.object({ id: z.string().uuid() }),
        response: { 200: deliveryResponse },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.retryDelivery,
  );

  app.post<{ Params: { id: string } }>(
    "/webhooks/logs/:id/retry",
    {
      schema: {
        hide: true,
        tags: ["admin", "webhooks"],
        summary: "Retry a webhook delivery log entry [legacy alias]",
        params: z.object({ id: z.string().uuid() }),
        response: { 200: deliveryResponse },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.retryDelivery,
  );

  app.post<{ Params: { id: string } }>(
    "/admin/webhooks/:id/test",
    {
      schema: {
        tags: ["admin", "webhooks"],
        summary: "Send a synthetic test webhook to this endpoint",
        params: z.object({ id: z.string().uuid() }),
        response: { 202: webhookTestResponseSchema },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.testWebhook,
  );

  app.post<{ Params: { id: string } }>(
    "/webhooks/:id/test",
    {
      schema: {
        hide: true,
        tags: ["admin", "webhooks"],
        summary: "Send a synthetic test webhook to this endpoint [legacy alias]",
        params: z.object({ id: z.string().uuid() }),
        response: { 202: webhookTestResponseSchema },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    webhooksController.testWebhook,
  );
}
