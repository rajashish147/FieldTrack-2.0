/**
 * Phase 15: Abuse Logging & Security Metrics Plugin
 *
 * Hooks into every response. When a request is rejected with HTTP 429
 * (rate limit exceeded), it:
 *
 *   1. Logs a structured warning with IP, route, and User-Agent.
 *   2. Increments the `security_rate_limit_hits_total` Prometheus counter.
 *   3. If the blocked route is an auth endpoint, additionally:
 *      - logs a brute-force warning with the client IP.
 *      - increments `security_auth_bruteforce_total`.
 */

import fp from "fastify-plugin";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
    securityRateLimitHits,
    securityAuthBruteforce,
} from "../prometheus.js";

/**
 * Auth route patterns that indicate a potential brute-force attack.
 * Extend this array as new protected endpoints are added.
 */
const AUTH_ROUTE_PATTERNS: RegExp[] = [
    /\/auth\//i,
    /\/login/i,
    /\/sign-?in/i,
    /\/token/i,
];

function isAuthRoute(route: string): boolean {
    return AUTH_ROUTE_PATTERNS.some((pattern) => pattern.test(route));
}

const abuseLoggingPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
    // codeql[js/missing-rate-limiting] -- This is the rate-limit telemetry hook, not a
    // route handler. It fires only after @fastify/rate-limit has already enforced the limit
    // (reply.statusCode === 429 guard below). Rate limiting is applied globally by
    // ratelimit.plugin.ts, which is registered before this plugin in app.ts.
    fastify.addHook("onResponse", async (request, reply) => {
        if (reply.statusCode !== 429) return;

        const route =
            request.routerPath ??
            request.routeOptions?.url ??
            request.raw.url?.split("?")[0] ??
            "unknown";

        const ip = request.ip;
        const userAgent = request.headers["user-agent"] ?? "unknown";

        // 1. Structured warning log for every rate-limited request.
        request.log.warn(
            { ip, route, userAgent, statusCode: 429 },
            "Rate limit triggered",
        );

        // 2. Increment generic rate-limit counter.
        securityRateLimitHits.labels(route).inc();

        // 3. Extra brute-force handling for auth endpoints.
        if (isAuthRoute(route)) {
            request.log.warn(
                {
                    ip,
                    route,
                    message: "Brute-force attempt detected on auth endpoint",
                },
                "Brute-force protection triggered",
            );

            securityAuthBruteforce.inc();
        }
    });

    fastify.log.info("security-abuse-logging plugin registered");
};

export default fp(abuseLoggingPlugin, {
    name: "security-abuse-logging",
    fastify: "5.x",
});
