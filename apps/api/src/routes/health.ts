import type { FastifyInstance } from "fastify";
import { getConfigHash } from "../config/env.js";

interface HealthResponse {
        status: string;
        timestamp: string;
        config_hash: string;
}

interface ReadyResponse {
    status: "ready" | "not_ready";
    timestamp: string;
    checks: {
        redis: "ok" | "error";
        supabase: "ok" | "error";
        bullmq: "ok" | "error";
        workers?: {
            status: "ok" | "error" | "skipped";
            active: number;
            expected: number;
        };
    };
}

const READY_CACHE_TTL_MS = 3000;
let readyCache: { expiresAt: number; response: ReadyResponse } | null = null;

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
            config_hash: getConfigHash(),
        };
    });

    app.get<{ Reply: ReadyResponse }>("/ready", {
        schema: { tags: ["health"] },
    }, async (_request, reply) => {
        if (readyCache && readyCache.expiresAt > Date.now()) {
            const cached = readyCache.response;
            if (cached.status !== "ready") {
                await reply.status(503).send(cached);
                return;
            }
            return cached;
        }

        // Lazy import to avoid triggering connections at module load
        const { supabaseServiceClient } = await import("../config/supabase.js");
        const { distanceQueue } = await import("../workers/distance.queue.js");
        const { analyticsQueue } = await import("../workers/analytics.queue.js");
        const { shouldStartWorkers, areWorkersStarted } = await import("../workers/startup.js");

        const checks: ReadyResponse["checks"] = {
            redis: "error",
            supabase: "error",
            bullmq: "error",
        };

        const [redisResult, supabaseResult, bullmqResult] = await Promise.allSettled([
            (async () => {
                const redisClient = await distanceQueue.waitUntilReady();
                await redisClient.ping();
            })(),
            (async () => {
                const { error } = await supabaseServiceClient
                    .from("organizations")
                    .select("id")
                    .limit(1);
                if (error) {
                    throw error;
                }
            })(),
            (async () => {
                await Promise.all([
                    distanceQueue.getWaitingCount(),
                    analyticsQueue.getWaitingCount(),
                ]);
            })(),
        ]);

        checks.redis = redisResult.status === "fulfilled" ? "ok" : "error";
        checks.supabase = supabaseResult.status === "fulfilled" ? "ok" : "error";
        checks.bullmq = bullmqResult.status === "fulfilled" ? "ok" : "error";
        if (!shouldStartWorkers(process.env)) {
            checks.workers = { status: "skipped", active: 0, expected: 2 };
        } else {
            const started = areWorkersStarted();
            checks.workers = { status: started ? "ok" : "error", active: started ? 2 : 0, expected: 2 };
        }

        const ready = checks.redis === "ok" && checks.supabase === "ok" && checks.bullmq === "ok";
        if (!ready) {
            const response: ReadyResponse = {
                status: "not_ready",
                timestamp: new Date().toISOString(),
                checks,
            };
            readyCache = {
                expiresAt: Date.now() + READY_CACHE_TTL_MS,
                response,
            };
            await reply.status(503).send(response);
            return;
        }

        const response: ReadyResponse = {
            status: "ready",
            timestamp: new Date().toISOString(),
            checks,
        };
        readyCache = {
            expiresAt: Date.now() + READY_CACHE_TTL_MS,
            response,
        };

        return response;
    });
}
