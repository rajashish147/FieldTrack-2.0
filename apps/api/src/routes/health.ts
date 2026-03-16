import type { FastifyInstance } from "fastify";
import Redis from "ioredis";
import { redisConnectionOptions } from "../config/redis.js";
import { supabaseServiceClient } from "../config/supabase.js";
import { distanceQueue } from "../workers/distance.queue.js";
import { analyticsQueue } from "../workers/analytics.queue.js";

interface HealthResponse {
    status: string;
    timestamp: string;
}

interface ReadyResponse {
    status: "ready" | "not_ready";
    timestamp: string;
    checks: {
        redis: "ok" | "error";
        supabase: "ok" | "error";
        bullmq: "ok" | "error";
    };
}

interface RootResponse {
    service: string;
    status: string;
    version: string;
    docs: string;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
    // Root — service identity probe.
    // Previously served by Nginx as a static response; now handled by Fastify
    // so the response goes through the same middleware chain as all other routes.
    app.get<{ Reply: RootResponse }>("/", {
        schema: { tags: ["health"] },
    }, async (_request, _reply) => {
        return {
            service: "FieldTrack 2.0",
            status: "online",
            version: "1.0.0",
            docs: "/docs",
        };
    });

    app.get<{ Reply: HealthResponse }>("/health", {
        schema: { tags: ["health"] },
    }, async (_request, _reply) => {
        return {
            status: "ok",
            timestamp: new Date().toISOString(),
        };
    });

    app.get<{ Reply: ReadyResponse }>("/ready", {
        schema: { tags: ["health"] },
    }, async (_request, reply) => {
        const checks: ReadyResponse["checks"] = {
            redis: "error",
            supabase: "error",
            bullmq: "error",
        };

        const redis = new Redis(redisConnectionOptions);
        try {
            await redis.ping();
            checks.redis = "ok";
        } catch {
            checks.redis = "error";
        } finally {
            redis.disconnect();
        }

        try {
            const { error } = await supabaseServiceClient
                .from("organizations")
                .select("id")
                .limit(1);
            checks.supabase = error ? "error" : "ok";
        } catch {
            checks.supabase = "error";
        }

        try {
            await Promise.all([
                distanceQueue.getWaitingCount(),
                analyticsQueue.getWaitingCount(),
            ]);
            checks.bullmq = "ok";
        } catch {
            checks.bullmq = "error";
        }

        const ready = checks.redis === "ok" && checks.supabase === "ok" && checks.bullmq === "ok";
        if (!ready) {
            await reply.status(503).send({
                status: "not_ready",
                timestamp: new Date().toISOString(),
                checks,
            });
            return;
        }

        return {
            status: "ready",
            timestamp: new Date().toISOString(),
            checks,
        };
    });
}
