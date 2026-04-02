/**
 * webhooks.integration.test.ts — Integration tests for the webhooks admin API.
 *
 * Tests cover:
 *  - POST   /admin/webhooks          — create (auth, validation, SSRF)
 *  - GET    /admin/webhooks          — list
 *  - PATCH  /admin/webhooks/:id      — update
 *  - DELETE /admin/webhooks/:id      — delete
 *  - GET    /admin/webhook-deliveries — list deliveries
 *  - POST   /admin/webhook-deliveries/:id/retry — manual retry
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../../../src/config/redis.js", () => ({
  redisClient: { on: vi.fn(), quit: vi.fn(), disconnect: vi.fn() },
  getRedisConnectionOptions: vi.fn().mockReturnValue({}),
  redisConnectionOptions: {},
}));

// shouldStartWorkers must return true so the retry endpoint does not reject
// with 503 "Workers not enabled" in test context.
vi.mock("../../../src/workers/startup.js", () => ({
  shouldStartWorkers: vi.fn().mockReturnValue(true),
  areWorkersStarted: vi.fn().mockReturnValue(true),
  startWorkers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/workers/distance.queue.js", () => ({
  enqueueDistanceJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/workers/analytics.queue.js", () => ({
  enqueueAnalyticsJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/workers/webhook.queue.js", () => ({
  enqueueWebhookDelivery: vi.fn().mockResolvedValue(undefined),
  enqueueToDlq:           vi.fn().mockResolvedValue(undefined),
  WEBHOOK_QUEUE_NAME:     "webhook-delivery",
  WEBHOOK_RETRY_DELAYS_MS: [0, 60_000, 300_000, 900_000, 3_600_000],
  WEBHOOK_MAX_ATTEMPTS:    5,
  getWebhookQueueDepth:   vi.fn().mockResolvedValue(0),
  getWebhookDlqDepth:     vi.fn().mockResolvedValue(0),
}));

vi.mock("../../../src/modules/webhooks/webhooks.repository.js", () => ({
  webhooksRepository: {
    create:                vi.fn(),
    list:                  vi.fn(),
    findById:              vi.fn(),
    update:                vi.fn(),
    delete:                vi.fn(),
    listDeliveries:        vi.fn(),
    listDlqDeliveries:     vi.fn(),
    findDeliveryById:      vi.fn(),
    findWebhookSecretById: vi.fn(),
    resetDeliveryForRetry: vi.fn(),
  },
}));

vi.mock("../../../src/config/supabase.js", () => ({
  supabaseServiceClient: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq:     vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
  },
}));

vi.mock("../../../src/auth/jwtVerifier.js", () => ({
  verifySupabaseToken: vi.fn().mockImplementation(async (token: string) => {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT structure");
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  }),
}));

import {
  buildTestApp,
  signAdminToken,
  signEmployeeToken,
  TEST_ADMIN_ID,
  TEST_ORG_ID,
  TEST_ORG_ID_B,
} from "../../setup/test-server.js";
import { webhooksRepository } from "../../../src/modules/webhooks/webhooks.repository.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const WEBHOOK_ID   = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DELIVERY_ID  = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const EVENT_ID     = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const now          = new Date().toISOString();

const webhookRow = {
  id:              WEBHOOK_ID,
  organization_id: TEST_ORG_ID,
  url:             "https://example.com/hook",
  is_active:       true,
  events:          ["expense.created", "expense.approved"],
  created_at:      now,
  updated_at:      now,
};

const deliveryRow = {
  id:               DELIVERY_ID,
  webhook_id:       WEBHOOK_ID,
  event_id:         EVENT_ID,
  organization_id:  TEST_ORG_ID,
  status:           "failed" as const,
  attempt_count:    3,
  response_status:  500,
  response_body:    "Internal Server Error",
  last_attempt_at:  now,
  next_retry_at:    null,
  created_at:       now,
};

const dlqDeliveryRow = {
  id:               DELIVERY_ID,
  webhook_id:       WEBHOOK_ID,
  organization_id:  TEST_ORG_ID,
  event_id:         EVENT_ID,
  event_type:       "expense.created",
  payload:          { type: "expense.created", amount: 123.45 },
  status:           "failed" as const,
  attempts:         3,
  response_status:  500,
  response_body:    "Internal Server Error",
  last_error:       "Receiver returned 500",
  next_retry_at:    null,
  last_attempt_at:  now,
  created_at:       now,
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Webhooks Admin API", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let adminTokenOrgB: string;
  let employeeToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    adminToken    = signAdminToken(app);
    adminTokenOrgB = signAdminToken(app, TEST_ADMIN_ID, TEST_ORG_ID_B);
    employeeToken = signEmployeeToken(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET /admin/webhooks ─────────────────────────────────────────────────────

  describe("GET /admin/webhooks", () => {
    it("returns 200 with list for ADMIN", async () => {
      vi.mocked(webhooksRepository.list).mockResolvedValueOnce([webhookRow]);

      const res = await app.inject({
        method:  "GET",
        url:     "/admin/webhooks",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ success: boolean; data: typeof webhookRow[] }>();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(WEBHOOK_ID);
      // Secret MUST NOT appear in the response
      expect(JSON.stringify(body)).not.toContain("secret");
    });

    it("returns 403 for EMPLOYEE role", async () => {
      const res = await app.inject({
        method:  "GET",
        url:     "/admin/webhooks",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 401 with no token", async () => {
      const res = await app.inject({ method: "GET", url: "/admin/webhooks" });
      expect(res.statusCode).toBe(401);
    });
  });

  // ─── POST /admin/webhooks ────────────────────────────────────────────────────

  describe("POST /admin/webhooks", () => {
    it("creates a webhook and returns 201", async () => {
      vi.mocked(webhooksRepository.create).mockResolvedValueOnce(webhookRow);

      const res = await app.inject({
        method:  "POST",
        url:     "/admin/webhooks",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body:    JSON.stringify({
          url:    "https://example.com/hook",
          events: ["expense.created"],
          secret: "super-secret-value-at-least-16-chars",
        }),
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ success: boolean; data: typeof webhookRow }>();
      expect(body.success).toBe(true);
      expect(body.data.url).toBe("https://example.com/hook");
    });

    it("rejects HTTP (non-HTTPS) URLs with 400", async () => {
      const res = await app.inject({
        method:  "POST",
        url:     "/admin/webhooks",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body:    JSON.stringify({
          url:    "http://example.com/hook",
          events: ["expense.created"],
          secret: "super-secret-value-at-least-16-chars",
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects private/loopback URLs with 400", async () => {
      const res = await app.inject({
        method:  "POST",
        url:     "/admin/webhooks",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body:    JSON.stringify({
          url:    "https://192.168.1.1/hook",
          events: ["expense.created"],
          secret: "super-secret-value-at-least-16-chars",
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects empty events array", async () => {
      const res = await app.inject({
        method:  "POST",
        url:     "/admin/webhooks",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body:    JSON.stringify({
          url:    "https://example.com/hook",
          events: [],
          secret: "super-secret-value-at-least-16-chars",
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects short secrets (<16 chars)", async () => {
      const res = await app.inject({
        method:  "POST",
        url:     "/admin/webhooks",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body:    JSON.stringify({
          url:    "https://example.com/hook",
          events: ["expense.created"],
          secret: "short",
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects unknown event types", async () => {
      const res = await app.inject({
        method:  "POST",
        url:     "/admin/webhooks",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body:    JSON.stringify({
          url:    "https://example.com/hook",
          events: ["unknown.event"],
          secret: "super-secret-value-at-least-16-chars",
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 403 for EMPLOYEE role", async () => {
      const res = await app.inject({
        method:  "POST",
        url:     "/admin/webhooks",
        headers: { authorization: `Bearer ${employeeToken}`, "content-type": "application/json" },
        body:    JSON.stringify({
          url:    "https://example.com/hook",
          events: ["expense.created"],
          secret: "super-secret-value-at-least-16-chars",
        }),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ─── PATCH /admin/webhooks/:id ───────────────────────────────────────────────

  describe("PATCH /admin/webhooks/:id", () => {
    it("updates a webhook", async () => {
      vi.mocked(webhooksRepository.findById).mockResolvedValueOnce(webhookRow);
      vi.mocked(webhooksRepository.update).mockResolvedValueOnce({
        ...webhookRow,
        is_active: false,
      });

      const res = await app.inject({
        method:  "PATCH",
        url:     `/admin/webhooks/${WEBHOOK_ID}`,
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body:    JSON.stringify({ is_active: false }),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ success: boolean; data: { is_active: boolean } }>();
      expect(body.data.is_active).toBe(false);
    });

    it("returns 404 when webhook not found", async () => {
      vi.mocked(webhooksRepository.findById).mockResolvedValueOnce(null);

      const res = await app.inject({
        method:  "PATCH",
        url:     `/admin/webhooks/${WEBHOOK_ID}`,
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body:    JSON.stringify({ is_active: false }),
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── DELETE /admin/webhooks/:id ──────────────────────────────────────────────

  describe("DELETE /admin/webhooks/:id", () => {
    it("deletes a webhook and returns 204", async () => {
      vi.mocked(webhooksRepository.findById).mockResolvedValueOnce(webhookRow);
      vi.mocked(webhooksRepository.delete).mockResolvedValueOnce(undefined);

      const res = await app.inject({
        method:  "DELETE",
        url:     `/admin/webhooks/${WEBHOOK_ID}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(204);
    });

    it("returns 404 when webhook not found", async () => {
      vi.mocked(webhooksRepository.findById).mockResolvedValueOnce(null);

      const res = await app.inject({
        method:  "DELETE",
        url:     `/admin/webhooks/${WEBHOOK_ID}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── GET /admin/webhook-deliveries ──────────────────────────────────────────

  describe("GET /admin/webhook-deliveries", () => {
    it("returns paginated delivery list", async () => {
      vi.mocked(webhooksRepository.listDeliveries).mockResolvedValueOnce({
        data:  [deliveryRow],
        total: 1,
      });

      const res = await app.inject({
        method:  "GET",
        url:     "/admin/webhook-deliveries",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ success: boolean; data: typeof deliveryRow[]; pagination: unknown }>();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].status).toBe("failed");
    });

    it("accepts webhook_id filter", async () => {
      vi.mocked(webhooksRepository.listDeliveries).mockResolvedValueOnce({
        data:  [],
        total: 0,
      });

      const res = await app.inject({
        method:  "GET",
        url:     `/admin/webhook-deliveries?webhook_id=${WEBHOOK_ID}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it("returns 403 for EMPLOYEE role", async () => {
      const res = await app.inject({
        method:  "GET",
        url:     "/admin/webhook-deliveries",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 401 with no token", async () => {
      const res = await app.inject({
        method: "GET",
        url:    "/admin/webhook-deliveries",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ─── GET /admin/webhook-dlq ────────────────────────────────────────────────

  describe("GET /admin/webhook-dlq", () => {
    it("returns failed deliveries for ADMIN", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked((webhooksRepository as any).listDlqDeliveries).mockResolvedValueOnce({
        data: [dlqDeliveryRow],
        total: 1,
      });

      const res = await app.inject({
        method:  "GET",
        url:     "/admin/webhook-dlq?limit=50&offset=0",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        success: boolean;
        data: typeof dlqDeliveryRow[];
        meta: { limit: number; offset: number; count: number };
      }>();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].status).toBe("failed");
      expect(body.meta).toEqual({ limit: 50, offset: 0, count: 1 });
    });

    it("accepts event_type and webhook_id filters", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked((webhooksRepository as any).listDlqDeliveries).mockResolvedValueOnce({
        data: [],
        total: 0,
      });

      const res = await app.inject({
        method: "GET",
        url: `/admin/webhook-dlq?event_type=expense.created&webhook_id=${WEBHOOK_ID}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it("returns 403 for EMPLOYEE role", async () => {
      const res = await app.inject({
        method:  "GET",
        url:     "/admin/webhook-dlq",
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 401 with no token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/webhook-dlq",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ─── POST /admin/webhook-dlq/:id/retry ─────────────────────────────────────

  describe("POST /admin/webhook-dlq/:id/retry", () => {
    it("retries a failed DLQ delivery", async () => {
      const { enqueueWebhookDelivery } = await import(
        "../../../src/workers/webhook.queue.js"
      );

      const webhookWithSecret = {
        id: WEBHOOK_ID,
        url: "https://example.com/hook",
        secret: "s3cr3t_value_long_enough",
      };
      const updatedDelivery = { ...deliveryRow, status: "pending" as const };

      vi.mocked(webhooksRepository.findDeliveryById).mockResolvedValueOnce(deliveryRow);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked((webhooksRepository as any).findWebhookSecretById).mockResolvedValueOnce(webhookWithSecret);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked((webhooksRepository as any).resetDeliveryForRetry).mockResolvedValueOnce(updatedDelivery);

      const res = await app.inject({
        method:  "POST",
        url:     `/admin/webhook-dlq/${DELIVERY_ID}/retry`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(vi.mocked(enqueueWebhookDelivery)).toHaveBeenCalledOnce();
    });

    it("returns 404 for admin from another organization", async () => {
      // Org-scoped lookup should return null for cross-org delivery ids.
      vi.mocked(webhooksRepository.findDeliveryById).mockResolvedValueOnce(null);

      const res = await app.inject({
        method:  "POST",
        url:     `/admin/webhook-dlq/${DELIVERY_ID}/retry`,
        headers: { authorization: `Bearer ${adminTokenOrgB}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 401 with no token", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/admin/webhook-dlq/${DELIVERY_ID}/retry`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ─── POST /admin/webhook-deliveries/:id/retry ───────────────────────────────

  describe("POST /admin/webhook-deliveries/:id/retry", () => {
    it("re-enqueues a failed delivery", async () => {
      const { enqueueWebhookDelivery } = await import(
        "../../../src/workers/webhook.queue.js"
      );

      const webhookWithSecret = {
        id:     WEBHOOK_ID,
        url:    "https://example.com/hook",
        secret: "s3cr3t_value_long_enough",
      };
      const updatedDelivery = { ...deliveryRow, status: "pending" };

      vi.mocked(webhooksRepository.findDeliveryById).mockResolvedValueOnce(deliveryRow);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked((webhooksRepository as any).findWebhookSecretById).mockResolvedValueOnce(webhookWithSecret);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked((webhooksRepository as any).resetDeliveryForRetry).mockResolvedValueOnce(updatedDelivery);

      const res = await app.inject({
        method:  "POST",
        url:     `/admin/webhook-deliveries/${DELIVERY_ID}/retry`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(vi.mocked(enqueueWebhookDelivery)).toHaveBeenCalledOnce();
    });

    it("returns 404 when delivery not found", async () => {
      vi.mocked(webhooksRepository.findDeliveryById).mockResolvedValueOnce(null);

      const res = await app.inject({
        method:  "POST",
        url:     `/admin/webhook-deliveries/${DELIVERY_ID}/retry`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 400 when delivery is already pending", async () => {
      vi.mocked(webhooksRepository.findDeliveryById).mockResolvedValueOnce({
        ...deliveryRow,
        status: "pending",
      });

      const res = await app.inject({
        method:  "POST",
        url:     `/admin/webhook-deliveries/${DELIVERY_ID}/retry`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 403 for EMPLOYEE role", async () => {
      const res = await app.inject({
        method:  "POST",
        url:     `/admin/webhook-deliveries/${DELIVERY_ID}/retry`,
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 401 with no token", async () => {
      const res = await app.inject({
        method: "POST",
        url:    `/admin/webhook-deliveries/${DELIVERY_ID}/retry`,
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
