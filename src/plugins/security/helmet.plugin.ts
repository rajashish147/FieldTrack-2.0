/**
 * Phase 15: Helmet Security Headers Plugin
 *
 * Registers @fastify/helmet globally to set secure HTTP response headers on
 * every reply (X-Frame-Options, X-Content-Type-Options, HSTS, etc.).
 *
 * CSP is intentionally disabled here — it will be configured in a later phase
 * once the exact script/style sources are locked down for the frontend.
 */

import fp from "fastify-plugin";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fastifyHelmet from "@fastify/helmet";

const helmetPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
    await fastify.register(fastifyHelmet, {
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                // 'unsafe-inline' required for Swagger UI inline styles
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", "data:"],
            },
        },
    });

    fastify.log.info("security-helmet plugin registered");
};

export default fp(helmetPlugin, {
    name: "security-helmet",
    fastify: "5.x",
});
