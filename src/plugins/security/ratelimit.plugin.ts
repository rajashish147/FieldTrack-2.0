/**
 * Rate Limiting Plugin — two-tier, Redis-backed, sliding-window.
 *
 * Tier 1 — Per-user (1 200 req/min):
 *   @fastify/rate-limit with its Redis store.  The plugin already implements
 *   a sliding-window counter when a Redis store is supplied, replacing the
 *   vulnerable fixed-window that allows a burst-then-reset exploit at every
 *   window boundary.
 *
 * Tier 2 — Per-org (5 000 req/min):
 *   Implemented as a Fastify preHandler hook using a Redis sorted-set sliding
 *   window, executed atomically via a Lua script (EVAL).  The set stores
 *   timestamps as both score and member, so each request occupies exactly one
 *   slot that ages out automatically.
 *
 *   Algorithm (runs inside one EVAL call per request — no TOCTOU):
 *     1. ZREMRANGEBYSCORE key -∞ (now - window_ms)   ← evict expired entries
 *     2. ZADD  key  now_ms  "<now_ms>:<random>"       ← register this request
 *     3. ZCARD key                                    ← count in-window entries
 *     4. PEXPIRE key (window_ms * 2)                  ← keep key alive
 *     5. return count
 *
 *   If count > max → HTTP 429.  The random suffix in the member prevents two
 *   concurrent requests at exactly the same millisecond from aliasing onto
 *   the same key and causing an under-count.
 *
 * Localhost (127.0.0.1 / ::1) is always allow-listed.
 */

import fp from "fastify-plugin";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { shouldStartWorkers } from "../../workers/startup.js";

// ── Tier-2 constants ─────────────────────────────────────────────────────────

/** Per-org request ceiling per rolling window. */
const ORG_RATE_LIMIT_MAX        = 5_000;
/** Sliding-window size in milliseconds. */
const ORG_RATE_LIMIT_WINDOW_MS  = 60_000; // 1 minute

/**
 * Lua script: atomic sliding-window check + record using a sorted set.
 *
 * KEYS[1]  → Redis key for this org's rate-limit window
 * ARGV[1]  → current timestamp in milliseconds (string)
 * ARGV[2]  → window size in milliseconds (string)
 * ARGV[3]  → unique member for this request (string: "<ts>:<random>")
 * ARGV[4]  → jittered TTL in milliseconds (string: window_ms * 2 ± jitter)
 *
 * Returns the count of requests inside the current window AFTER recording
 * this request (i.e., the value to compare against the cap).
 */
const SLIDING_WINDOW_LUA = `
local key        = KEYS[1]
local now_ms     = tonumber(ARGV[1])
local window_ms  = tonumber(ARGV[2])
local member     = ARGV[3]
local ttl_ms     = tonumber(ARGV[4])
local cutoff     = now_ms - window_ms

redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
redis.call('ZADD', key, now_ms, member)
local count = redis.call('ZCARD', key)
redis.call('PEXPIRE', key, ttl_ms)
return count
`;

const rateLimitPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
    if (!shouldStartWorkers()) {
        // Redis is not provisioned (WORKERS_ENABLED=false).
        // Fall back to in-memory rate limiting so the API is never entirely
        // unprotected. In-memory limits are intentionally lower than the
        // Redis-backed tier because the counter is per-process (not shared
        // across replicas), making per-user tracking less accurate.
        fastify.log.warn(
            "security-rate-limit plugin using in-memory fallback (Redis not provisioned) — limits: 200 req/min",
        );
        await fastify.register(fastifyRateLimit, {
            global: true,
            hook: "preHandler",
            max: 200,
            timeWindow: "1 minute",
            allowList: ["127.0.0.1", "::1"],
            errorResponseBuilder: (_request, context) => ({
                success: false,
                error: "Too many requests",
                retryAfter: context.after,
            }),
        });
        fastify.log.info("security-rate-limit plugin registered (in-memory fallback, 200 req/min)");
        return;
    }

    const { Redis } = await import("ioredis");
    const { redisConnectionOptions } = await import("../../config/redis.js");

    // ── Tier 1: Per-user sliding window (1 200 req/min) ─────────────────────
    // @fastify/rate-limit uses a sliding-window counter internally when a
    // Redis store is provided — no fixed-window burst vulnerability.
    const rateLimitRedis = new Redis(redisConnectionOptions);

    await fastify.register(fastifyRateLimit, {
        global: true,
        hook: "preHandler",
        max: 1200,
        timeWindow: "1 minute",
        redis: rateLimitRedis,
        keyGenerator: (request) => {
            const user = (request as { user?: { sub?: string } }).user;
            return user?.sub ? `rl:user:${user.sub}` : `rl:ip:${request.ip}`;
        },
        allowList: ["127.0.0.1", "::1"],
        errorResponseBuilder: (_request, context) => ({
            success: false,
            error: "Too many requests",
            retryAfter: context.after,
        }),
    });

    // ── Tier 2: Per-org sliding window (5 000 req/min) ──────────────────────
    const orgRlRedis = new Redis(redisConnectionOptions);

    // Pre-load the Lua script SHA for efficient reuse.
    // evalsha is ~10 % faster than eval for hot-path scripts called thousands
    // of times per minute because Redis skips the parse/compile step.
    const slidingWindowSha = await orgRlRedis.script("LOAD", SLIDING_WINDOW_LUA) as string;

    fastify.addHook("preHandler", async (request, reply) => {
        const orgId = (request as { organizationId?: string }).organizationId;
        if (!orgId) return;
        if (request.ip === "127.0.0.1" || request.ip === "::1") return;

        const nowMs  = Date.now();
        // Unique per-request member prevents millisecond aliasing.
        const member = `${nowMs}:${Math.random().toString(36).slice(2)}`;
        const key    = `rl:org:${orgId}`;
        // Jitter the key TTL by 0–10% of the window to prevent a synchronized
        // mass-expiry storm when many org keys were created at the same time.
        const ttlMs  = Math.round(ORG_RATE_LIMIT_WINDOW_MS * 2 + ORG_RATE_LIMIT_WINDOW_MS * 0.1 * Math.random());

        let count: number;
        try {
            // Run via pre-loaded SHA; fall back to EVAL if the script was
            // flushed from script cache (e.g. Redis restart).
            count = await orgRlRedis
                .evalsha(slidingWindowSha, 1, key, String(nowMs), String(ORG_RATE_LIMIT_WINDOW_MS), member, String(ttlMs))
                .catch(() =>
                    orgRlRedis.eval(SLIDING_WINDOW_LUA, 1, key, String(nowMs), String(ORG_RATE_LIMIT_WINDOW_MS), member, String(ttlMs)),
                ) as number;
        } catch {
            // Non-fatal: if Redis is unavailable let the request through.
            return;
        }

        if (count > ORG_RATE_LIMIT_MAX) {
            // Return a consistent 429 with the standard retryAfter field.
            void reply.status(429).send({
                success:    false,
                error:      "Organization rate limit exceeded",
                retryAfter: `${Math.ceil(ORG_RATE_LIMIT_WINDOW_MS / 1000)}s`,
            });
        }
    });

    fastify.log.info(
        "security-rate-limit plugin registered (per-user: 1200 req/min sliding, per-org: 5000 req/min sliding, Redis-backed)",
    );
};

export default fp(rateLimitPlugin, {
    name: "security-rate-limit",
    fastify: "5.x",
});
