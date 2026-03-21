import "./tracing.js";
import { env, getConfigHash, getEnv, logStartupConfig } from "./config/env.js";
import { buildApp } from "./app.js";
import { shouldStartWorkers } from "./workers/startup.js";

async function start(): Promise<void> {
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

    // Structured startup config log — safe values only, no secrets.
    // Logs APP_ENV, PORT, all base URLs, CORS policy, Tempo endpoint, and the
    // deployed commit SHA so operators can verify the deployment in one glance
    // at Grafana/Loki without needing to inspect the container environment.
    logStartupConfig(app.log);
    app.log.info({ readyEndpoint: "/ready" }, "[BOOT] infra readiness checks available");

    // Start workers and recovery explicitly after the server is listening.
    // This keeps worker lifecycle deterministic and prevents import-time starts.
    const shouldStartWorkersNow = shouldStartWorkers(process.env);
    app.log.info(
      {
        shouldStartWorkers: shouldStartWorkersNow,
        CI_MODE: process.env.CI_MODE,
        SKIP_EXTERNAL_SERVICES: process.env.SKIP_EXTERNAL_SERVICES,
        NODE_ENV: process.env.NODE_ENV,
      },
      "[BOOT] worker startup decision",
    );

    if (shouldStartWorkersNow) {
      const { startWorkers } = await import("./workers/startup.js");
      const { performStartupRecovery } = await import("./workers/distance.worker.js");
      const { replayPendingRetryIntents } = await import("./workers/retry-intents.js");
      const { startRetryIntentCleanupJob } = await import("./workers/retry-cleanup.job.js");

      await startWorkers(app);
      app.log.info({ activeWorkers: 2 }, "[BOOT] workers started");
      performStartupRecovery(app);
      void replayPendingRetryIntents(app);
      startRetryIntentCleanupJob(app);
    } else {
      app.log.info(
        {
          skipExternalServices: process.env.SKIP_EXTERNAL_SERVICES,
          ciMode: process.env.CI_MODE,
          ci: process.env.CI,
          nodeEnv: process.env.NODE_ENV,
          appEnv: process.env.APP_ENV,
        },
        "Background workers and recovery are disabled in this runtime mode",
      );
    }
  } catch (error) {
    app.log.error(error, "Failed to start server");
    process.exit(1);
  }
}

start();
