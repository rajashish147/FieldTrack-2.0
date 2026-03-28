/**
 * webhook-dlq.routes.ts — Admin API for failed webhook deliveries.
 *
 * GET  /admin/webhook-dlq         — list failed webhook deliveries for this org
 * POST /admin/webhook-dlq/:id/retry — retry a failed delivery
 *
 * This route is DB-backed off `public.webhook_deliveries`, not the in-memory
 * BullMQ DLQ queue. It is always registered so unauthenticated callers receive
 * 401 instead of 404 even when workers are disabled.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { webhooksService } from "../webhooks/webhooks.service.js";
import { handleError } from "../../utils/response.js";
import {
  dlqListQuerySchema,
  webhookDlqDeliverySchema,
} from "../webhooks/webhooks.schema.js";

const dlqListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(webhookDlqDeliverySchema),
  meta: z.object({
    limit: z.number().int(),
    offset: z.number().int(),
    count: z.number().int(),
  }),
});

const dlqRetryResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    id: z.string().uuid(),
    status: z.string(),
    attempt_count: z.number(),
    next_retry_at: z.string().nullable(),
  }),
});

export async function webhookDlqRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /admin/webhook-dlq ─────────────────────────────────────────────────
  app.get(
    "/admin/webhook-dlq",
    {
      schema: {
        tags: ["admin", "webhooks"],
        description: "List failed webhook deliveries for this organization (ADMIN only).",
        querystring: dlqListQuerySchema,
        response: { 200: dlqListResponseSchema },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const query = dlqListQuerySchema.parse(request.query);
        const { data, total } = await webhooksService.listDlqDeliveries(request, query);
        reply.status(200).send({
          success: true,
          data,
          meta: {
            limit: query.limit,
            offset: query.offset,
            count: total,
          },
        });
      } catch (error) {
        handleError(error, request, reply, "Failed to list DLQ deliveries");
      }
    },
  );

  // ── POST /admin/webhook-dlq/:id/retry ─────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/admin/webhook-dlq/:id/retry",
    {
      schema: {
        tags: ["admin", "webhooks"],
        description: "Retry a failed webhook delivery (ADMIN only).",
        params: z.object({ id: z.string().uuid() }),
        response: { 200: dlqRetryResponseSchema },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const { id: deliveryId } = request.params;
        const delivery = await webhooksService.retryDelivery(request, deliveryId);

        reply.status(200).send({
          success: true,
          data: {
            id: delivery.id,
            status: delivery.status,
            attempt_count: delivery.attempt_count,
            next_retry_at: delivery.next_retry_at,
          },
        });
      } catch (error) {
        handleError(error, request, reply, "Failed to retry DLQ delivery");
      }
    },
  );
}
