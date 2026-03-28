/**
 * webhooks.schema.ts — Zod schemas for the webhooks admin API.
 *
 * WEBHOOK_EVENT_TYPES is the canonical list of events that can be subscribed
 * to. These must stay in sync with the EventDataMap keys in event-bus.ts.
 */

import { z } from "zod";

// ─── Event type constants ────────────────────────────────────────────────────

export const WEBHOOK_EVENT_TYPES = [
  "employee.checked_in",
  "employee.checked_out",
  "expense.created",
  "expense.approved",
  "expense.rejected",
  "employee.created",
] as const;

export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];

// ─── Row shape ────────────────────────────────────────────────────────────────

/** Public-safe webhook row — secret is stripped before sending to clients. */
export const webhookPublicSchema = z.object({
  id:              z.string().uuid(),
  organization_id: z.string().uuid(),
  url:             z.string().url(),
  is_active:       z.boolean(),
  events:          z.array(z.string()),
  created_at:      z.string(),
  updated_at:      z.string(),
});

export type WebhookPublic = z.infer<typeof webhookPublicSchema>;

// ─── Request bodies ───────────────────────────────────────────────────────────

export const createWebhookBodySchema = z.object({
  url: z
    .string()
    .min(1, "url is required")
    .url("url must be a valid URL"),
  events: z
    .array(z.enum(WEBHOOK_EVENT_TYPES))
    .min(1, "events must contain at least one event type"),
  secret: z
    .string()
    .min(16, "secret must be at least 16 characters")
    .max(256, "secret must be at most 256 characters"),
});
export type CreateWebhookBody = z.infer<typeof createWebhookBodySchema>;

export const updateWebhookBodySchema = z
  .object({
    url:       z.string().url().optional(),
    events:    z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).optional(),
    is_active: z.boolean().optional(),
    secret:    z
      .string()
      .min(16, "secret must be at least 16 characters")
      .max(256)
      .optional(),
  })
  .refine(
    (v) =>
      v.url !== undefined ||
      v.events !== undefined ||
      v.is_active !== undefined ||
      v.secret !== undefined,
    { message: "At least one field must be provided for update" },
  );
export type UpdateWebhookBody = z.infer<typeof updateWebhookBodySchema>;

// ─── Delivery row ─────────────────────────────────────────────────────────────

export const webhookDeliverySchema = z.object({
  id:              z.string().uuid(),
  webhook_id:      z.string().uuid(),
  event_id:        z.string().uuid(),
  organization_id: z.string().uuid(),
  status:          z.enum(["pending", "success", "failed"]),
  attempt_count:   z.number(),
  response_status: z.number().nullable(),
  response_body:   z.string().nullable(),
  last_attempt_at: z.string().nullable(),
  next_retry_at:   z.string().nullable(),
  created_at:      z.string(),
});
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

export const webhookDlqDeliverySchema = z.object({
  id:              z.string().uuid(),
  webhook_id:      z.string().uuid(),
  organization_id: z.string().uuid(),
  event_id:        z.string().uuid(),
  event_type:      z.string().nullable(),
  payload:         z.unknown().nullable(),
  status:          z.literal("failed"),
  attempts:        z.number(),
  response_status: z.number().nullable(),
  response_body:   z.string().nullable(),
  last_error:      z.string().nullable(),
  next_retry_at:   z.string().nullable(),
  // DB and API use the same timestamp name to avoid semantic drift.
  last_attempt_at: z.string().nullable(),
  created_at:      z.string(),
});
export type WebhookDlqDelivery = z.infer<typeof webhookDlqDeliverySchema>;

// ─── Query params ──────────────────────────────────────────────────────────────

export const deliveryListQuerySchema = z.object({
  page:       z.coerce.number().int().positive().default(1),
  limit:      z.coerce.number().int().min(1).max(100).default(20),
  webhook_id: z.string().uuid().optional(),
  status:     z.enum(["pending", "success", "failed"]).optional(),
});
export type DeliveryListQuery = z.infer<typeof deliveryListQuerySchema>;

export const dlqListQuerySchema = z.object({
  limit:      z.coerce.number().int().min(1).max(100).default(50),
  offset:     z.coerce.number().int().min(0).default(0),
  event_type: z.string().min(1).optional(),
  webhook_id: z.string().uuid().optional(),
});
export type DlqListQuery = z.infer<typeof dlqListQuerySchema>;
