import jwksClient from "jwks-rsa";
import jwt from "jsonwebtoken";
import type { JwtPayload as JoseJwtPayload } from "jsonwebtoken";
import { env } from "../config/env.js";

const { verify, decode } = jwt;

/**
 * JWKS client for fetching Supabase signing keys.
 * 
 * Supabase signs JWTs using ES256 (asymmetric) and rotates keys periodically.
 * This client fetches the public keys from Supabase's JWKS endpoint and caches them.
 * 
 * Caching strategy:
 * - Reduces external JWKS endpoint calls (performance + stability)
 * - 5 concurrent keys cached (typical for Supabase key rotation)
 * - 10-minute TTL (allows key rotation to propagate)
 * 
 * Phase 20: Authentication Layer Fix
 */
const client = jwksClient({
  jwksUri: `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
  cache: true,              // Enable in-memory caching
  cacheMaxEntries: 5,       // Hold up to 5 keys in memory
  cacheMaxAge: 600000,      // 10 minutes; allows key rotation to propagate
});

/**
 * Fetches the signing key for a given JWT.
 * Called automatically by jsonwebtoken during verification.
 * 
 * @param header - JWT header (must include 'kid' for JWKS lookup)
 * @param callback - callback(err, key)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getKey = (header: any, callback: any): void => {
  const kid = (header as Record<string, string>).kid;
  
  // Fail fast if kid is missing — prevents falling back to cached key or default key
  if (!kid) {
    callback(new Error("JWT missing 'kid' header — cannot look up JWKS key"));
    return;
  }
  
  client.getSigningKey(kid, (err, key) => {
    if (err) {
      callback(err);
      return;
    }
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
};

/**
 * Supabase JWT payload structure.
 *
 * IMPORTANT — claim sources after custom_access_token_hook runs:
 *
 *   role        — Supabase built-in; overridden to "ADMIN" or "EMPLOYEE" by the
 *                 hook reading public.users.role. Without the hook it is "authenticated".
 *   org_id      — Injected by hook from public.users.organization_id.
 *   employee_id — Injected by hook from public.employees.id (EMPLOYEE role only).
 *
 *   user_metadata — user-controlled via supabase.auth.updateUser().
 *                   NEVER use for authorization decisions.
 */
export interface SupabaseJwtPayload extends JoseJwtPayload {
  sub: string;
  email?: string;
  aud?: string;         // Token audience — must be "authenticated" for user tokens
  role?: string;        // Overridden by hook: "ADMIN" | "EMPLOYEE". Without hook: "authenticated".
  org_id?: string;      // Injected by custom_access_token_hook (organization UUID)
  employee_id?: string; // Injected by custom_access_token_hook (EMPLOYEE role only)
  // Legacy claim location used by Phase 5 hook (app_metadata.*)
  // Kept for backward compatibility during token-rotation window.
  app_metadata?: {
    role?: string;            // legacy: application role
    organization_id?: string; // legacy: org UUID
    employee_id?: string;     // legacy: employee UUID
    [key: string]: unknown;
  };
  user_metadata?: {
    [key: string]: unknown; // user-controlled — do NOT use for authorization decisions
  };
}

/**
 * Layer 1 — Token Verification
 * 
 * Verifies a Supabase JWT token using JWKS with asymmetric ES256 keys.
 * 
 * Security hardening (prevents algorithm confusion attacks + key confusion):
 * - JWKS endpoint provides Supabase's public keys only (asymmetric)
 * - Verification explicitly restricts algorithms to ["ES256"] (no HS256 fallback)
 * - Audience must be "authenticated" (blocks service_role and anon tokens)
 * - Issuer must EXACTLY match Supabase auth endpoint (no trailing slash tricks)
 * - Key ID (kid) is REQUIRED in JWT header; missing kid fails immediately
 * - Header algorithm is validated using jsonwebtoken.decode() (safe base64url handling)
 * - Clock tolerance of 5 seconds handles minor server time drift
 * 
 * Responsibilities:
 * - Verify JWT signature using Supabase's public keys via JWKS
 * - Validate token structure and all required claims
 * - Return decoded payload
 * 
 * Does NOT:
 * - Load user data from database
 * - Attach anything to request
 * - Handle HTTP responses
 * 
 * This separation allows reuse in:
 * - Background workers
 * - Internal API calls
 * - Admin tools
 * - WebSocket authentication
 * 
 * @param token - The JWT token to verify
 * @returns Decoded and verified payload
 * @throws Error if token is invalid, signature doesn't match, or verification fails
 */
export async function verifySupabaseToken(
  token: string
): Promise<SupabaseJwtPayload> {
  return new Promise((resolve, reject) => {
    // Defensive Step 1: Decode header safely using jsonwebtoken.decode()
    // This handles base64url decoding properly (safer than manual Buffer.from parsing)
    const decodedWithHeader = decode(token, { complete: true });
    
    if (!decodedWithHeader || typeof decodedWithHeader === "string") {
      reject(new Error("Invalid JWT format"));
      return;
    }
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const header = decodedWithHeader.header as any;
    
    // Defensive Step 2: Validate algorithm in header (before signature verification)
    if (header.alg !== "ES256") {
      reject(new Error(`Algorithm mismatch: expected 'ES256', got '${String(header.alg)}'`));
      return;
    }
    
    // Defensive Step 3: Enforce key ID (kid) presence
    // kid is essential for JWKS lookup; missing kid prevents verification
    if (!header.kid) {
      reject(new Error("JWT missing 'kid' header — cannot verify without key ID"));
      return;
    }
    
    // Step 4: Verify signature using JWKS (via getKey callback)
    verify(
      token,
      getKey,
      {
        algorithms: ["ES256"],                    // CRITICAL: Restrict to ES256 only
        audience: "authenticated",                // Blocks service_role, anon tokens
        issuer: `${env.SUPABASE_URL}/auth/v1`,   // EXACT match (no trailing slash tricks)
        clockTolerance: 5,                        // 5s tolerance for minor time drift
      },
      (err, decoded) => {
        if (err) {
          reject(err);
          return;
        }
        
        const payload = decoded as SupabaseJwtPayload;
        
        // Production safety check: validate audience
        // Supabase issues different token types (service_role, anon, authenticated)
        // Only allow authenticated user tokens
        if (payload.aud !== "authenticated") {
          reject(new Error(`Invalid token audience: ${payload.aud}`));
          return;
        }
        
        resolve(payload);
      }
    );
  });
}
