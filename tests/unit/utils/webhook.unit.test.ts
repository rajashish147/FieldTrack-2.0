/**
 * webhook.unit.test.ts — Unit tests for Phase 25 webhook system.
 *
 * Covers:
 *  - HMAC signature generation and verification (utils/hmac.ts)
 *  - URL validation (utils/url-validator.ts)
 *  - Retry delay schedule (workers/webhook.queue.ts)
 *  - WEBHOOK_EVENT_TYPES schema coverage
 *
 * Note: processEventForWebhooks fan-out logic is covered by integration tests
 * (tests/integration/admin/webhooks.integration.test.ts) where the full module
 * graph can be wired up without vi.doMock / vi.resetModules complications.
 */

import { describe, it, expect, vi } from "vitest";

// Mock Redis and BullMQ queue creation so importing webhook.queue.ts does not
// attempt a real TCP connection to redis://localhost:6379 in unit-test context.
vi.mock("../../../src/config/redis.js", () => ({
  redisClient:             { on: vi.fn(), quit: vi.fn(), disconnect: vi.fn() },
  getRedisConnectionOptions: vi.fn().mockReturnValue({ host: "localhost", port: 6379 }),
  redisConnectionOptions:  { host: "localhost", port: 6379 },
}));

// ─── hmac.ts ─────────────────────────────────────────────────────────────────

describe("generateSignature", () => {
  it("should produce sha256= prefixed hex string", async () => {
    const { generateSignature } = await import("../../../src/utils/hmac.js");
    const sig = generateSignature("secret", "hello");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("should produce consistent output for same inputs", async () => {
    const { generateSignature } = await import("../../../src/utils/hmac.js");
    expect(generateSignature("s", "p")).toBe(generateSignature("s", "p"));
  });

  it("should produce different signatures for different secrets", async () => {
    const { generateSignature } = await import("../../../src/utils/hmac.js");
    expect(generateSignature("secret1", "payload")).not.toBe(
      generateSignature("secret2", "payload"),
    );
  });

  it("should produce different signatures for different payloads", async () => {
    const { generateSignature } = await import("../../../src/utils/hmac.js");
    expect(generateSignature("secret", "payload1")).not.toBe(
      generateSignature("secret", "payload2"),
    );
  });
});

describe("generateSignatureWithTimestamp", () => {
  it("should sign timestamp.payload and return timestamp", async () => {
    const { generateSignature, generateSignatureWithTimestamp } = await import("../../../src/utils/hmac.js");
    const payload = JSON.stringify({ id: "evt_123" });
    const ts = 1_700_000_000;
    const { signature, timestamp } = generateSignatureWithTimestamp("secret", payload, ts);

    expect(timestamp).toBe(ts);
    expect(signature).toBe(generateSignature("secret", `${ts}.${payload}`));
  });
});

describe("verifySignature", () => {
  it("should return true for a correctly generated signature", async () => {
    const { generateSignature, verifySignature } = await import("../../../src/utils/hmac.js");
    const secret  = "my-signing-secret";
    const payload = JSON.stringify({ id: "evt_123", type: "expense.created" });
    const sig     = generateSignature(secret, payload);
    expect(verifySignature(secret, payload, sig)).toBe(true);
  });

  it("should return false for a tampered payload", async () => {
    const { generateSignature, verifySignature } = await import("../../../src/utils/hmac.js");
    const secret  = "my-signing-secret";
    const sig     = generateSignature(secret, '{"amount":100}');
    expect(verifySignature(secret, '{"amount":999}', sig)).toBe(false);
  });

  it("should return false for a different secret", async () => {
    const { generateSignature, verifySignature } = await import("../../../src/utils/hmac.js");
    const payload = "test-payload";
    const sig     = generateSignature("secret-a", payload);
    expect(verifySignature("secret-b", payload, sig)).toBe(false);
  });

  it("should return false for length-differing strings without crashing", async () => {
    const { verifySignature } = await import("../../../src/utils/hmac.js");
    expect(verifySignature("s", "p", "sha256=short")).toBe(false);
  });
});

describe("verifySignatureWithTimestamp", () => {
  it("returns true for valid signature inside tolerance", async () => {
    const { generateSignatureWithTimestamp, verifySignatureWithTimestamp } = await import(
      "../../../src/utils/hmac.js"
    );
    const payload = JSON.stringify({ type: "expense.created" });
    const now = 1_700_000_000;
    const { signature, timestamp } = generateSignatureWithTimestamp("secret", payload, now - 60);

    expect(
      verifySignatureWithTimestamp("secret", payload, signature, timestamp, now, 300),
    ).toBe(true);
  });

  it("returns false when timestamp is outside tolerance", async () => {
    const { generateSignatureWithTimestamp, verifySignatureWithTimestamp } = await import(
      "../../../src/utils/hmac.js"
    );
    const payload = JSON.stringify({ type: "expense.created" });
    const now = 1_700_000_000;
    const { signature, timestamp } = generateSignatureWithTimestamp("secret", payload, now - 400);

    expect(
      verifySignatureWithTimestamp("secret", payload, signature, timestamp, now, 300),
    ).toBe(false);
  });
});

// ─── url-validator.ts ─────────────────────────────────────────────────────────

describe("validateWebhookUrl", () => {
  it("should pass for a public HTTPS URL", async () => {
    const { validateWebhookUrl } = await import("../../../src/utils/url-validator.js");
    expect(() => validateWebhookUrl("https://example.com/webhook")).not.toThrow();
  });

  it("should reject http:// URLs", async () => {
    const { validateWebhookUrl } = await import("../../../src/utils/url-validator.js");
    expect(() => validateWebhookUrl("http://example.com/webhook")).toThrow(
      /Only HTTPS URLs are permitted/,
    );
  });

  it("should reject localhost URLs", async () => {
    const { validateWebhookUrl } = await import("../../../src/utils/url-validator.js");
    expect(() => validateWebhookUrl("https://localhost/hook")).toThrow(
      /private.*not permitted/i,
    );
  });

  it("should reject 127.x.x.x IPs", async () => {
    const { validateWebhookUrl } = await import("../../../src/utils/url-validator.js");
    expect(() => validateWebhookUrl("https://127.0.0.1/hook")).toThrow();
  });

  it("should reject AWS metadata endpoint", async () => {
    const { validateWebhookUrl } = await import("../../../src/utils/url-validator.js");
    expect(() => validateWebhookUrl("https://169.254.169.254/latest/meta-data")).toThrow();
  });

  it("should reject private 192.168.x.x IPs", async () => {
    const { validateWebhookUrl } = await import("../../../src/utils/url-validator.js");
    expect(() => validateWebhookUrl("https://192.168.1.100/hook")).toThrow();
  });

  it("should reject malformed URLs", async () => {
    const { validateWebhookUrl } = await import("../../../src/utils/url-validator.js");
    expect(() => validateWebhookUrl("not-a-url")).toThrow();
  });
});

// ─── webhook.queue.ts — retry schedule ───────────────────────────────────────

describe("WEBHOOK_RETRY_DELAYS_MS", () => {
  it("should have 5 delay slots matching spec", async () => {
    const { WEBHOOK_RETRY_DELAYS_MS, WEBHOOK_MAX_ATTEMPTS } = await import(
      "../../../src/workers/webhook.queue.js"
    );
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(5);
    expect(WEBHOOK_RETRY_DELAYS_MS).toHaveLength(5);
    expect(WEBHOOK_RETRY_DELAYS_MS[0]).toBe(0);           // attempt 1 immediate
    expect(WEBHOOK_RETRY_DELAYS_MS[1]).toBe(60_000);      // attempt 2 → 1 min
    expect(WEBHOOK_RETRY_DELAYS_MS[2]).toBe(300_000);     // attempt 3 → 5 min
    expect(WEBHOOK_RETRY_DELAYS_MS[3]).toBe(900_000);     // attempt 4 → 15 min
    expect(WEBHOOK_RETRY_DELAYS_MS[4]).toBe(3_600_000);   // attempt 5 → 1 h
  });
});

describe("calculateRetryDelay", () => {
  it("should never return less than base delay", async () => {
    const { calculateRetryDelay, WEBHOOK_RETRY_DELAYS_MS } = await import(
      "../../../src/workers/webhook.queue.js"
    );
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(calculateRetryDelay(2)).toBe(WEBHOOK_RETRY_DELAYS_MS[1]);
    vi.restoreAllMocks();
  });

  it("should cap jitter at +20% when Math.random() is 1", async () => {
    const { calculateRetryDelay } = await import("../../../src/workers/webhook.queue.js");
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(calculateRetryDelay(2)).toBe(72_000); // 60_000 + 20%
    vi.restoreAllMocks();
  });
});

// ─── WEBHOOK_EVENT_TYPES coverage ─────────────────────────────────────────────

describe("WEBHOOK_EVENT_TYPES", () => {
  it("should include all required event types", async () => {
    const { WEBHOOK_EVENT_TYPES } = await import(
      "../../../src/modules/webhooks/webhooks.schema.js"
    );
    const required = [
      "employee.checked_in",
      "employee.checked_out",
      "expense.created",
      "expense.approved",
      "expense.rejected",
      "employee.created",
    ] as const;
    for (const evt of required) {
      expect(WEBHOOK_EVENT_TYPES).toContain(evt);
    }
  });
});
