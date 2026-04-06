import { initTelemetry } from "./tracing.js";
import { env, getConfigHash, getEnv, logStartupConfig } from "./config/env.js";
import { buildApp } from "./app.js";
import { shouldStartWorkers, getExpectedWorkerCount } from "./workers/startup.js";
import { setBootstrapped } from "./routes/health.js";

async function start(): Promise<void> {
  // Start OTel before any Fastify/HTTP listener so auto-instrumentation hooks
  // fire before the first request is handled. Must precede buildApp().
  initTelemetry();

  // Force environment validation at process startup so production fails fast.
  // Lazy env loading remains useful for tests and CI that do not run server.ts.
  getEnv();
  const configHash = getConfigHash();

  const app = await buildApp();
  app.log.info({ configHash, appEnv: env.APP_ENV }, "[BOOT] config loaded");

  // Phase 11: Graceful shutdown.
  // Docker sends SIGTERM on container stop. Without this, Redis connections
  // and BullMQ workers can hang and delay container shutdown indefinitely.
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down gracefully...`);
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    app.log.info({ port: env.PORT, appEnv: env.APP_ENV }, "[BOOT] server listening");

    // Mark the process as bootstrapped: all plugins and routes are registered
    // and the HTTP server is bound. /health returns 200 from this point.
    setBootstrapped();

    // Structured startup config log — safe values only, no secrets.
    // Logs APP_ENV, PORT, all base URLs, CORS policy, Tempo endpoint, and the
    // deployed commit SHA so operators can verify the deployment in one glance
    // at Grafana/Loki without needing to inspect the container environment.
    logStartupConfig(app.log);
    app.log.info({ readyEndpoint: "/ready" }, "[BOOT] infra readiness checks available");

    // Start workers and recovery explicitly after the server is listening.
    // This keeps worker lifecycle deterministic and prevents import-time starts.
    const shouldStartWorkersNow = shouldStartWorkers();
    app.log.info(
      {
        shouldStartWorkers: shouldStartWorkersNow,
        workersEnabled: env.WORKERS_ENABLED,
        appEnv: env.APP_ENV,
      },
      "[BOOT] worker startup decision",
    );

    if (shouldStartWorkersNow) {
      const { startWorkers, startScheduledJobs } = await import("./workers/startup.js");
      const { performStartupRecovery } = await import("./workers/distance.worker.js");
      const { replayPendingRetryIntents } = await import("./workers/retry-intents.js");

      // Phase 3: Redis resilience — worker startup failures must not crash the
      // process. BullMQ workers retry Redis connections internally; a transient
      // Redis unavailability at boot time should not prevent traffic serving.
      try {
        await startWorkers(app);
        app.log.info({ activeWorkers: getExpectedWorkerCount() }, "[BOOT] workers started");
        performStartupRecovery(app);
        void replayPendingRetryIntents(app);
        await startScheduledJobs(app);

        // Restore any open circuit-breaker states from DB into Redis so that
        // delivery workers respect open circuits after a Redis flush/restart.
        const { syncCircuitBreakerState } = await import("./workers/circuit-breaker.js");
        const { getRedisConnectionOptions } = await import("./config/redis.js");
        const { Redis } = await import("ioredis");
        const cbSyncRedis = new Redis(getRedisConnectionOptions());
        cbSyncRedis.on("error", () => { /* non-fatal */ });
        void syncCircuitBreakerState(cbSyncRedis, app.log).finally(() => {
          void cbSyncRedis.quit().catch(() => undefined);
        });
      } catch (workerErr) {
        // Workers failed to start (Redis likely unavailable at boot time).
        // The HTTP server is already bound and serving; /ready will reflect
        // the degraded state. Log the error and continue — do not exit.
        app.log.error(
          { error: workerErr instanceof Error ? workerErr.message : String(workerErr) },
          "[BOOT] workers failed to start — server continues without background workers. /ready will return 503 until Redis is available.",
        );
      }
    } else {
      app.log.info(
        {
          workersEnabled: env.WORKERS_ENABLED,
          appEnv: env.APP_ENV,
        },
        "Background workers not started — WORKERS_ENABLED=false or APP_ENV=test",
      );
    }
  } catch (error) {
    app.log.error(error, "Failed to start server");
    process.exit(1);
  }
}

start();
