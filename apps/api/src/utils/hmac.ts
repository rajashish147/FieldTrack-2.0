/**
 * hmac.ts — HMAC-SHA256 signature utilities for FieldTrack 2.0.
 *
 * Used by the Phase 25 webhook delivery worker to sign outbound payloads.
 * Receivers verify the signature by computing the same HMAC over the raw
 * request body and comparing against the `X-FieldTrack-Signature` header.
 *
 * Format: sha256=<hex-encoded-digest>
 * This matches the industry convention used by GitHub, Stripe, and Shopify
 * webhooks, making it familiar to integration developers.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// ─── Signature Generation ─────────────────────────────────────────────────────

/**
 * Generate an HMAC-SHA256 signature for a given payload string.
 *
 * The `secret` should be the per-webhook secret stored in the `webhooks` table.
 * The `payload` should be the raw JSON string that will be included in the
 * request body — do NOT pass a parsed object (JSON serialization is not stable).
 *
 * @param secret   The webhook's signing secret (plaintext, not hashed).
 * @param payload  The raw request body as a string.
 * @returns        Signature string in the format `sha256=<hex>`.
 *
 * @example
 *   const sig = generateSignature(webhook.secret, JSON.stringify(envelope));
 *   // → "sha256=a3f1c..."
 */
export function generateSignature(secret: string, payload: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(payload, "utf8");
  return `sha256=${hmac.digest("hex")}`;
}

// ─── Signature Verification ───────────────────────────────────────────────────

/**
 * Verify that a received signature matches the expected signature.
 *
 * Uses `timingSafeEqual` to prevent timing-oracle attacks that would allow
 * an attacker to infer secret bytes by measuring response latency differences.
 *
 * Both signatures must be ASCII-comparable strings (hex-encoded).  If the
 * lengths differ they can never be equal, so we short-circuit before the
 * buffer comparison to avoid a length-mismatch error.
 *
 * @param secret    The webhook's signing secret.
 * @param payload   The raw request body string.
 * @param received  The `X-FieldTrack-Signature` header value to verify.
 * @returns         `true` if the signature is valid, `false` otherwise.
 */
export function verifySignature(
  secret: string,
  payload: string,
  received: string,
): boolean {
  const expected = generateSignature(secret, payload);

  // timingSafeEqual requires equal-length Buffers.
  if (expected.length !== received.length) return false;

  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(received, "utf8"));
}
