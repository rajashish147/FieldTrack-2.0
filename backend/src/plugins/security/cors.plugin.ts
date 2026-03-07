/**
 * Phase 15: CORS Protection Plugin
 *
 * Registers @fastify/cors using the ALLOWED_ORIGINS environment variable.
 * When ALLOWED_ORIGINS is empty (e.g. local development), all origins are
 * permitted. In production the env var should be set to the explicit list of
 * trusted frontend origins.
 *
 * credentials: true — required so that Cookie / Authorization headers are
 * forwarded by the browser in cross-origin requests.
 */

import fp from "fastify-plugin";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fastifyCors from "@fastify/cors";
import { env } from "../../config/env.js";

const corsPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
    await fastify.register(fastifyCors, {
        // Use explicit allow-list from env in production; allow all origins in dev.
        origin: env.ALLOWED_ORIGINS.length > 0 ? env.ALLOWED_ORIGINS : true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        credentials: true,
    });

    fastify.log.info("security-cors plugin registered");
};

export default fp(corsPlugin, {
    name: "security-cors",
    fastify: "5.x",
});
