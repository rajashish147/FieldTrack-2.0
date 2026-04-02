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
 * POST   /admin/webhook-deliveries/:id/retry    — manually retry a failed delivery
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
}
