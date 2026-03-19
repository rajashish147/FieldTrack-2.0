import type { FastifyInstance } from "fastify";
import { distanceQueue } from "../workers/distance.queue.js";
import { env } from "../config/env.js";

interface DebugRedisResponse {
  status: "ok" | "error";
  redis: string;
}

/**
 * Debug routes for observability validation.
 *
 * GET /debug/redis — pings Redis via the existing BullMQ ioredis connection.
 * Because OpenTelemetry ioredis instrumentation wraps the underlying client,
 * this call produces a downstream span and creates the
 * fieldtrack-backend → redis edge in the Tempo service graph.
 *
 * Phase 18: Restricted to development/staging environments only.
 * In production, this endpoint is disabled to prevent infrastructure
 * information disclosure.
 */
export async function debugRoutes(app: FastifyInstance): Promise<void> {
  // Only register debug routes in non-production environments
  if (env.APP_ENV === "production") {
    app.log.info("Debug routes disabled in production");
    return;
  }

  app.get<{ Reply: DebugRedisResponse }>(
    "/debug/redis",
    async (request, reply): Promise<void> => {
      try {
        // Reuse the ioredis connection that BullMQ already owns.
        // waitUntilReady() resolves to the same RedisClient instance used by
        // the queue — no new TCP connection is opened.
        const redisClient = await distanceQueue.waitUntilReady();
        const pong = await redisClient.ping();

        request.log.info({ redis: pong }, "debug/redis ping succeeded");
        void reply.status(200).send({ status: "ok", redis: pong });
      } catch (error) {
        request.log.error({ err: error }, "debug/redis ping failed");
        void reply.status(503).send({ status: "error", redis: "unreachable" });
      }
    },
  );
}
