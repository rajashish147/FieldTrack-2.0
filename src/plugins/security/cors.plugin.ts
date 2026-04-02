/**
 * Phase 15: CORS Protection Plugin
 *
 * Registers @fastify/cors with a fully deterministic origin policy.
 * Wildcard origin (`true` / `*`) is NEVER used in any environment.
 *
 * Origin resolution strategy:
 *
 *   1. If CORS_ORIGIN is set (non-empty comma-separated list):
 *      → Use that explicit list in every environment.
 *        This lets a developer test against a non-standard local port,
 *        a staging env restrict to its own frontend, and production lock
 *        down to its exact domain(s) — all with the same code path.
 *
 *   2. If CORS_ORIGIN is empty AND APP_ENV === "development":
 *      → Fall back to DEV_CORS_ORIGINS (localhost:3000 + localhost:5173).
 *        These are the standard ports for Create React App and Vite.
 *        The dev fallback is explicit, not a wildcard, so the policy is
 *        still auditable and cannot accidentally reach production.
 *
 *   3. If CORS_ORIGIN is empty AND APP_ENV !== "development":
 *      → This state is unreachable at runtime because env.ts superRefine
 *        blocks startup in production/staging when CORS_ORIGIN is empty.
 *        The empty-array fallback here is a belt-and-suspenders guard only.
 *
 * credentials: true — required so Cookie / Authorization headers are
 * forwarded by the browser in cross-origin requests.
 *
 * Multiple origins are supported via a comma-separated CORS_ORIGIN value:
 *   CORS_ORIGIN=https://app.fieldtrack.com,https://admin.fieldtrack.com
 */

import fp from "fastify-plugin";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fastifyCors from "@fastify/cors";
import { env, getCorsOrigins } from "../../config/env.js";

// ─── Development safe-list ────────────────────────────────────────────────────
//
// Used ONLY when APP_ENV==="development" and CORS_ORIGIN is unset.
// These are the canonical local ports for the two most common frontend
// dev servers (Create React App → 3000, Vite → 5173).
//
// This list is intentionally a compile-time constant — it is not read from
// env because it only applies to local development where there are no secrets
// at risk. Keeping it here makes the fallback behaviour explicit and auditable.

const DEV_CORS_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5173",
] as const;

// ─── Origin resolver ──────────────────────────────────────────────────────────

/**
 * Resolve the effective CORS origin list for the current environment.
 *
 * Precedence (highest → lowest):
 *   1. Explicit CORS_ORIGIN env var  (any environment)
 *   2. DEV_CORS_ORIGINS constant     (development only)
 *   3. Empty array                   (unreachable — superRefine blocks this)
 *
 * Always returns a string[], never `true` or `*`.
 *
 * @param appEnv     - Validated APP_ENV value from env.ts.
 * @param configured - Parsed corsOrigins array from env.ts.
 */
function resolveOrigins(
    appEnv: string,
    configured: readonly string[],
): string[] {
    // 1. Explicit CORS_ORIGIN always wins regardless of environment.
    if (configured.length > 0) {
        return [...configured];
    }

    // 2. Development fallback — safe local origins, never a wildcard.
    if (appEnv === "development") {
        return [...DEV_CORS_ORIGINS];
    }

    // 3. Should be unreachable: superRefine in env.ts prevents startup in
    //    production/staging when CORS_ORIGIN is empty. Return empty array
    //    (deny all) as the safest possible fallback rather than allowing all.
    return [];
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const corsPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
    const effectiveOrigins = resolveOrigins(env.APP_ENV, getCorsOrigins());

    await fastify.register(fastifyCors, {
        origin: effectiveOrigins,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        credentials: true,
    });

    fastify.log.info(
        {
            appEnv:            env.APP_ENV,
            originsConfigured: effectiveOrigins.length,
            origins:           effectiveOrigins,
            source:
                getCorsOrigins().length > 0
                    ? "CORS_ORIGIN env var"
                    : env.APP_ENV === "development"
                        ? "DEV_CORS_ORIGINS fallback"
                        : "empty (deny-all fallback — should be unreachable)",
        },
        "security-cors plugin registered",
    );
};

export default fp(corsPlugin, {
    name: "security-cors",
    fastify: "5.x",
});
