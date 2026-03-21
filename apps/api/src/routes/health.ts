import type { FastifyInstance } from "fastify";
import { createHash } from "crypto";
import { env } from "../config/env.js";

interface HealthResponse {
    status: string;
    timestamp: string;
    config_hash: string;
}

// Compute lazily on first request — the config doesn't change at runtime.
// Matches the hash emitted by logStartupConfig so /health and the startup
// log can be cross-referenced without querying Loki.
let _configHash: string | undefined;
function getConfigHash(): string {
  if (!_configHash) {
    _configHash = createHash("sha256")
      .update(
        JSON.stringify({
          configVersion: env.CONFIG_VERSION,
          appEnv:        env.APP_ENV,
          port:          env.PORT,
          appBaseUrl:    env.APP_BASE_URL      ?? "",
          apiBaseUrl:    env.API_BASE_URL      ?? "",
          frontendUrl:   env.FRONTEND_BASE_URL ?? "",
          serviceName:   env.SERVICE_NAME,
          corsOrigin:    env.CORS_ORIGIN,
        }),
      )
      .digest("hex")
      .slice(0, 12);
  }
  return _configHash;
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
