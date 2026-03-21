/**
 * Phase 15: Redis-backed Rate Limiting Plugin
 *
 * Registers @fastify/rate-limit globally with a Redis store so that limits are
 * enforced across all container replicas — never in process-memory.
 *
 * Global defaults: 1200 requests / minute per authenticated user (keyed by
 * Authorization header).  This is intentionally generous — an admin polling
 * the dashboard every 5 s consumes only 12 req/min.  The strict cap exists to
 * block runaway loops, not legitimate clients.
 *
 * Keying by token (not IP) means multiple real users behind the same NAT or
 * load-test runner each get their own independent quota.
 *
 * Routes that need stricter limits (e.g. auth) can override via route config:
 *
 *   {
 *     config: {
 *       rateLimit: { max: 5, timeWindow: '1 minute' }
 *     }
 *   }
 *
 * Localhost (127.0.0.1 / ::1) is always allow-listed so health checks and
 * internal tooling never trigger limits.
 */

import fp from "fastify-plugin";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";

const rateLimitPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
    // Skip rate limiting in CI mode when Redis is unavailable
    if (process.env.SKIP_EXTERNAL_SERVICES === "true") {
        fastify.log.info("security-rate-limit plugin SKIPPED (SKIP_EXTERNAL_SERVICES=true)");
        return;
    }

    // Lazy import Redis only when needed
    const { Redis } = await import("ioredis");
    const { redisConnectionOptions } = await import("../../config/redis.js");
    const rateLimitRedis = new Redis(redisConnectionOptions);

    await fastify.register(fastifyRateLimit, {
        global: true,
        hook: "preHandler",
        max: 1200,
        timeWindow: "1 minute",

        // Redis store — required for Docker / multi-instance deployments.
        redis: rateLimitRedis,

        // Key by validated user ID (sub claim from JWT) so each authenticated
        // user gets their own quota. This is more secure than keying by the
        // raw Authorization header since it uses the verified identity.
        // Unauthenticated requests fall back to client IP.
        keyGenerator: (request) => {
            const user = (request as { user?: { sub?: string } }).user;
            if (user?.sub) {
                return `user:${user.sub}`;
            }
            return `ip:${request.ip}`;
        },

        // Bypass rate limiting for localhost health checks / internal tooling.
        allowList: ["127.0.0.1", "::1"],

        // Return a machine-readable error body on 429.
        errorResponseBuilder: (_request, context) => ({
            success: false,
            error: "Too many requests",
            retryAfter: context.after,
        }),
    });

    fastify.log.info("security-rate-limit plugin registered (Redis-backed, 1200 req/min per token)");
};

export default fp(rateLimitPlugin, {
    name: "security-rate-limit",
    fastify: "5.x",
});
