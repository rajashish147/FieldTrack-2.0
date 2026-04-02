/**
 * url-validator.ts — Anti-SSRF webhook URL validation for FieldTrack 2.0.
 *
 * Before storing or dispatching to a webhook URL, the system must ensure that
 * the URL cannot be weaponised to make the server issue requests to internal
 * infrastructure (SSRF — Server-Side Request Forgery).
 *
 * Threat model:
 *  - Attacker registers a webhook pointing to an internal service
 *    (e.g. http://redis:6379, http://169.254.169.254/latest/meta-data/).
 *  - The webhook delivery worker would then make an outbound HTTP request
 *    on the attacker's behalf, potentially leaking secrets or triggering
 *    unintended side-effects.
 *
 * Mitigations applied here:
 *  1. Protocol enforcement — only HTTPS is permitted.
 *  2. Hostname blocklist — loopback, link-local, private, and cloud metadata
 *     addresses are rejected at parse time.
 *
 * NOTE: DNS rebinding is not mitigated at the validation layer; the delivery
 * worker should additionally resolve the hostname at connection time and
 * reject private IPs there (defense-in-depth). This validator is the first
 * gate, not the only one.
 *
 * TODO(Phase 25 — delivery worker HTTP client):
 *   Resolve the webhook hostname immediately before opening the outbound
 *   TCP connection and validate the resolved IP against the same private
 *   ranges checked here.  This closes the DNS rebinding window:
 *
 *     1. Attacker registers  webhook → https://evil.example.com
 *     2. validateWebhookUrl()  passes — evil.example.com resolves to a
 *        public IP at registration time.
 *     3. Before delivery, attacker changes the DNS record to
 *        169.254.169.254 (AWS/GCP metadata endpoint).
 *     4. Without runtime resolution, the delivery worker would follow
 *        the updated record and hit the metadata service.
 *
 *   Implementation sketch (in the delivery worker, NOT here):
 *
 *     import dns from "node:dns/promises";
 *     const { address } = await dns.lookup(hostname);
 *     if (isPrivateAddress(address)) throw new SsrfBlockedError(address);
 *
 *   Where isPrivateAddress() mirrors the BLOCKED_HOSTNAME_PATTERNS below
 *   but operates on resolved IP strings rather than raw hostname strings.
 *   Use dns.lookup() (not dns.resolve()) so it respects /etc/hosts and
 *   matches the address the OS networking stack would actually connect to.
 */

// ─── Error Type ───────────────────────────────────────────────────────────────

export class InvalidWebhookUrlError extends Error {
  readonly statusCode = 422;

  constructor(reason: string) {
    super(`Invalid webhook URL: ${reason}`);
    this.name = "InvalidWebhookUrlError";
  }
}

// ─── Private Address Patterns ─────────────────────────────────────────────────

/**
 * Hostname patterns that map to private, loopback, link-local, or otherwise
 * internal addresses.  Matched against the lower-cased hostname extracted
 * by `new URL()` (which decodes percent-encoding and brackets IPv6).
 *
 * Covered ranges:
 *   Loopback    : localhost, 127.0.0.0/8, ::1
 *   Unspecified : 0.0.0.0
 *   Private     : 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *   Link-local  : 169.254.0.0/16 (incl. AWS/GCP metadata 169.254.169.254)
 *   IPv6 private: fc00::/7 (ULA), fe80::/10 (link-local)
 */
const BLOCKED_HOSTNAME_PATTERNS: ReadonlyArray<RegExp> = [
  // Loopback
  /^localhost$/,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^::1$/,

  // Unspecified
  /^0\.0\.0\.0$/,

  // RFC-1918 private ranges
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,

  // Link-local (covers cloud instance metadata: 169.254.169.254)
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  /^fe80:/,

  // IPv6 Unique Local Addresses (fc00::/7)
  /^f[cd][0-9a-f]{2}:/,
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate a webhook URL for safety and compliance.
 *
 * Throws `InvalidWebhookUrlError` with a descriptive reason if the URL fails
 * any check.  Returns `void` on success so callers can use it as a guard:
 *
 * @example
 *   validateWebhookUrl(body.url); // throws if invalid
 *   await webhooksRepository.create(...);
 *
 * @throws {InvalidWebhookUrlError}
 */
export function validateWebhookUrl(rawUrl: string): void {
  // ── 1. Parse ──────────────────────────────────────────────────────────────
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidWebhookUrlError("URL is malformed or cannot be parsed");
  }

  // ── 2. Protocol enforcement ───────────────────────────────────────────────
  if (parsed.protocol !== "https:") {
    throw new InvalidWebhookUrlError(
      `Only HTTPS URLs are permitted (received protocol: ${parsed.protocol})`,
    );
  }

  // ── 3. Private/internal hostname check ────────────────────────────────────
  const hostname = parsed.hostname.toLowerCase();

  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      // Intentionally vague error message — do not reveal which rule matched
      // to avoid giving attackers information about the detection patterns.
      throw new InvalidWebhookUrlError(
        "Loopback, private, and link-local addresses are not permitted",
      );
    }
  }
}
