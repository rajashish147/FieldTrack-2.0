import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { env } from "./config/env.js";
import { getLoggerConfig } from "./config/logger.js";
import { registerJwt } from "./plugins/jwt.js";
import { registerRoutes } from "./routes/index.js";
import fastifyRateLimit from "@fastify/rate-limit";
import { startDistanceWorker } from "./workers/queue.js";

export async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({
        logger: getLoggerConfig(env.NODE_ENV),
    });

    // Register plugins
    await app.register(fastifyRateLimit, {
        global: false, // We will apply it specifically where needed
    });
    await registerJwt(app);

    // Register routes
    await registerRoutes(app);

    // Bootstrap Phase 7 Background Workers
    // We explicitly do NOT await this because it's a perpetual infinite loop
    startDistanceWorker(app);

    return app;
}
