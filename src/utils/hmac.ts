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

// ─── Replay-Safe Signature ────────────────────────────────────────────────────

/**
 * Generate a timestamp-bound HMAC-SHA256 signature for outbound webhook delivery.
 *
 * Signing body: `{timestamp}.{payload}` — this binds the signature to both the
 * payload content AND the delivery time, making captured requests non-replayable
 * after the tolerance window (receivers should reject timestamps older than ~5 min).
 *
 * Returns both the Unix timestamp (seconds) used in signing, and the signature
 * string.  The caller must send `X-FieldTrack-Timestamp: <ts>` as a header so
 * the receiver can reconstruct the signed string for verification.
 *
 * @param secret   The per-webhook signing secret.
 * @param payload  The raw request body string.
 * @param tsSeconds  Unix timestamp in seconds (defaults to `Date.now() / 1000 | 0`).
 * @returns        `{ signature: "sha256=<hex>", timestamp: number }`
 */
export function generateSignatureWithTimestamp(
  secret: string,
  payload: string,
  tsSeconds = (Date.now() / 1000) | 0,
): { signature: string; timestamp: number } {
  const signingBody = `${tsSeconds}.${payload}`;
  const hmac = createHmac("sha256", secret);
  hmac.update(signingBody, "utf8");
  const signature = `sha256=${hmac.digest("hex")}`;
  return { signature, timestamp: tsSeconds };
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

/**
 * Verify timestamp-bound signature with replay-window enforcement.
 *
 * Signing input must be `{timestamp}.{payload}` and the timestamp must be
 * inside the accepted tolerance window (default ±300 s).
 */
export function verifySignatureWithTimestamp(
  secret: string,
  payload: string,
  received: string,
  timestampSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  if (!Number.isInteger(timestampSeconds)) return false;
  if (!Number.isInteger(nowSeconds)) return false;
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) return false;
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) return false;

  const expected = generateSignature(secret, `${timestampSeconds}.${payload}`);
  if (expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(received, "utf8"));
}
