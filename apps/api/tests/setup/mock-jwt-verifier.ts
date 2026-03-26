import { vi } from "vitest";

/**
 * Global integration-test mock for verifySupabaseToken.
 *
 * auth.ts calls verifySupabaseToken (Supabase JWKS / ES256).
 * Integration tests sign tokens with @fastify/jwt (HS256 / test secret).
 * These two mechanisms are cryptographically incompatible, so this mock
 * decodes the HS256 test-token payload without signature verification and
 * returns it as a SupabaseJwtPayload so auth.ts receives the expected claims.
 *
 * Scope:
 *   - Applied globally to ALL test files via vitest.config.ts setupFiles.
 *   - Security test files (role-escalation, auth-validation, etc.) that need
 *     per-test control declare their own vi.mock() for jwtVerifier.js.
 *     A test-file-level vi.mock() overrides this setup-file factory for that
 *     file only, so the security tests are unaffected.
 */
vi.mock("../../src/auth/jwtVerifier.js", () => ({
  verifySupabaseToken: vi.fn().mockImplementation(async (token: string) => {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid JWT structure");
    }
    // Decode payload without signature verification (integration test env only).
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  }),
}));
