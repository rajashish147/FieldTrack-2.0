/**
 * Phase 15: Redis-backed Rate Limiting Plugin
 *
 * Registers @fastify/rate-limit globally with a Redis store so that limits are
 * enforced across all container replicas — never in process-memory.
 *
 * Global defaults: 100 requests / minute per client IP.
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
import { Redis } from "ioredis";
import { redisConnectionOptions } from "../../config/redis.js";

// Dedicated ioredis connection for rate-limit store (separate from BullMQ).
const rateLimitRedis = new Redis(redisConnectionOptions);

const rateLimitPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
    await fastify.register(fastifyRateLimit, {
        global: true,
        max: 100,
        timeWindow: "1 minute",

        // Redis store — required for Docker / multi-instance deployments.
        redis: rateLimitRedis,

        // Key = client IP address.
        keyGenerator: (request) => request.ip,

        // Bypass rate limiting for localhost health checks / internal tooling.
        allowList: ["127.0.0.1", "::1"],

        // Return a machine-readable error body on 429.
        errorResponseBuilder: (_request, context) => ({
            success: false,
            error: "Too many requests",
            retryAfter: context.after,
        }),
    });

    fastify.log.info("security-rate-limit plugin registered (Redis-backed, 100 req/min global)");
};

export default fp(rateLimitPlugin, {
    name: "security-rate-limit",
    fastify: "5.x",
});
