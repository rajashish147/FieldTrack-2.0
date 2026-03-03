import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { env } from "./config/env.js";
import { getLoggerConfig } from "./config/logger.js";
import { registerJwt } from "./plugins/jwt.js";
import { registerRoutes } from "./routes/index.js";

export async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({
        logger: getLoggerConfig(env.NODE_ENV),
    });

    // Register plugins
    await registerJwt(app);

    // Register routes
    await registerRoutes(app);

    return app;
}
