/**
 * webhooks.repository.ts — Data access layer for webhooks, webhook_events,
 * and webhook_deliveries tables.
 *
 * All queries are org-scoped via orgTable() to enforce tenant isolation.
 * INSERT and UPSERT operations set organization_id explicitly and call
 * supabaseServiceClient directly (matching existing repository conventions).
 */

import type { FastifyRequest } from "fastify";
import { orgTable } from "../../db/query.js";
import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import type {
  CreateWebhookBody,
  UpdateWebhookBody,
  WebhookPublic,
  WebhookDelivery,
  DeliveryListQuery,
  DlqListQuery,
  WebhookDlqDelivery,
} from "./webhooks.schema.js";

const WEBHOOK_DELIVERY_COLUMNS =
  "id, webhook_id, event_id, organization_id, status, attempt_count, response_status, response_body, last_attempt_at, next_retry_at, created_at";
const WEBHOOK_DLQ_COLUMNS =
  "id, webhook_id, organization_id, event_id, event_type, payload, status, attempt_count, response_status, response_body, last_error, next_retry_at, last_attempt_at, created_at";

// ─── Webhook CRUD ─────────────────────────────────────────────────────────────

export const webhooksRepository = {
  /**
   * Create a new webhook for the request's organization.
   * The secret is stored but never returned in listing/get responses.
   */
  async create(
    request: FastifyRequest,
    body: CreateWebhookBody,
  ): Promise<WebhookPublic> {
    const { data, error } = await supabase
      .from("webhooks")
      .insert({
        organization_id: request.organizationId,
        url:             body.url,
        secret:          body.secret,
        events:          body.events as string[],
        is_active:       true,
      })
      .select("id, organization_id, url, is_active, events, created_at, updated_at")
      .single();

    if (error) throw new Error(`Failed to create webhook: ${error.message}`);
    return data as WebhookPublic;
  },

  /** Return all webhooks for the request's organization (secret excluded). */
  async list(request: FastifyRequest): Promise<WebhookPublic[]> {
    const { data, error } = await orgTable(request, "webhooks")
      .select("id, organization_id, url, is_active, events, created_at, updated_at")
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Failed to list webhooks: ${error.message}`);
    return (data ?? []) as WebhookPublic[];
  },

  /** Fetch a single webhook by id, org-scoped. Returns null if not found. */
  async findById(
    request: FastifyRequest,
    webhookId: string,
  ): Promise<WebhookPublic | null> {
    const { data, error } = await orgTable(request, "webhooks")
      .select("id, organization_id, url, is_active, events, created_at, updated_at")
      .eq("id", webhookId)
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`Failed to fetch webhook: ${error.message}`);
    return (data as WebhookPublic | null) ?? null;
  },

  /** Update a webhook's mutable fields (url, events, is_active, secret). */
  async update(
    request: FastifyRequest,
    webhookId: string,
    body: UpdateWebhookBody,
  ): Promise<WebhookPublic> {
    const patch: Record<string, unknown> = {};
    if (body.url       !== undefined) patch.url       = body.url;
    if (body.events    !== undefined) patch.events    = body.events;
    if (body.is_active !== undefined) patch.is_active = body.is_active;
    if (body.secret    !== undefined) patch.secret    = body.secret;

    const { data, error } = await orgTable(request, "webhooks")
      .update(patch)
      .eq("id", webhookId)
      .select("id, organization_id, url, is_active, events, created_at, updated_at")
      .single();

    if (error) throw new Error(`Failed to update webhook: ${error.message}`);
    return data as WebhookPublic;
  },

  /** Soft-delete: permanently remove the webhook row (and cascade deliveries). */
  async delete(request: FastifyRequest, webhookId: string): Promise<void> {
    const { error } = await orgTable(request, "webhooks")
      .delete()
      .eq("id", webhookId);

    if (error) throw new Error(`Failed to delete webhook: ${error.message}`);
  },

  // ─── Deliveries ─────────────────────────────────────────────────────────────

  /** Paginated list of delivery attempts for the request's org. */
  async listDeliveries(
    request: FastifyRequest,
    query: DeliveryListQuery,
  ): Promise<{ data: WebhookDelivery[]; total: number }> {
    const from = (query.page - 1) * query.limit;
    const to   = from + query.limit - 1;

    let q = orgTable(request, "webhook_deliveries")
      .select(WEBHOOK_DELIVERY_COLUMNS, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);

    // Chainable filters — orgTable returns a select builder
    if (query.webhook_id) {
      q = (q as ReturnType<typeof q.eq>).eq("webhook_id", query.webhook_id);
    }
    if (query.status) {
      q = (q as ReturnType<typeof q.eq>).eq("status", query.status);
    }

    const { data, error, count } = await q;

    if (error) throw new Error(`Failed to list deliveries: ${error.message}`);
    return { data: (data ?? []) as WebhookDelivery[], total: count ?? 0 };
  },

  /**
   * Paginated list of failed delivery rows for the admin DLQ view.
   *
   * Uses `last_attempt_at` consistently in both DB query and API response.
   */
  async listDlqDeliveries(
    request: FastifyRequest,
    query: DlqListQuery,
  ): Promise<{ data: WebhookDlqDelivery[]; total: number }> {
    const from = query.offset;
    const to = query.offset + query.limit - 1;

    let q = orgTable(request, "webhook_deliveries")
      .select(WEBHOOK_DLQ_COLUMNS, { count: "exact" })
      .eq("status", "failed")
      .order("last_attempt_at", { ascending: false, nullsFirst: false })
      .range(from, to);

    if (query.webhook_id) {
      q = (q as ReturnType<typeof q.eq>).eq("webhook_id", query.webhook_id);
    }
    if (query.event_type) {
      q = (q as ReturnType<typeof q.eq>).eq("event_type", query.event_type);
    }

    const { data, error, count } = await q;
    if (error) throw new Error(`Failed to list webhook DLQ deliveries: ${error.message}`);

    const rows = (data ?? []) as Array<{
      id: string;
      webhook_id: string;
      organization_id: string;
      event_id: string;
      event_type: string | null;
      payload: unknown | null;
      status: "failed";
      attempt_count: number;
      response_status: number | null;
      response_body: string | null;
      last_error: string | null;
      next_retry_at: string | null;
      last_attempt_at: string | null;
      created_at: string;
    }>;

    return {
      data: rows.map((row) => ({
        id: row.id,
        webhook_id: row.webhook_id,
        organization_id: row.organization_id,
        event_id: row.event_id,
        event_type: row.event_type,
        payload: row.payload,
        status: row.status,
        attempts: row.attempt_count,
        response_status: row.response_status,
        response_body: row.response_body,
        last_error: row.last_error,
        next_retry_at: row.next_retry_at,
        last_attempt_at: row.last_attempt_at,
        created_at: row.created_at,
      })),
      total: count ?? 0,
    };
  },

  /** Fetch a single delivery row by id. */
  async findDeliveryById(
    request: FastifyRequest,
    deliveryId: string,
  ): Promise<WebhookDelivery | null> {
    const { data, error } = await orgTable(request, "webhook_deliveries")
      .select(WEBHOOK_DELIVERY_COLUMNS)
      .eq("id", deliveryId)
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`Failed to fetch delivery: ${error.message}`);
    return (data as WebhookDelivery | null) ?? null;
  },

  /**
   * Fetch a webhook's url and secret for delivery — only the fields
   * needed by the retry / queue path.
   */
  async findWebhookSecretById(
    request: FastifyRequest,
    webhookId: string,
  ): Promise<{ id: string; url: string; secret: string } | null> {
    const { data, error } = await orgTable(request, "webhooks")
      .select("id, url, secret")
      .eq("id", webhookId)
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`Failed to fetch webhook secret: ${error.message}`);
    return (data as { id: string; url: string; secret: string } | null) ?? null;
  },

  /** Reset a delivery to pending with an updated next_retry_at. */
  async resetDeliveryForRetry(
    request: FastifyRequest,
    deliveryId: string,
    nextRetryAt: string,
  ): Promise<WebhookDelivery> {
    const { data, error } = await orgTable(request, "webhook_deliveries")
      .update({ status: "pending", next_retry_at: nextRetryAt })
      .eq("id", deliveryId)
      .select(WEBHOOK_DELIVERY_COLUMNS)
      .single();

    if (error) throw new Error(`Failed to reset delivery: ${error.message}`);
    return data as WebhookDelivery;
  },
};
