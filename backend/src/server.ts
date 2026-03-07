import "./tracing.js";
import { env } from "./config/env.js";
import { buildApp } from "./app.js";
import { performStartupRecovery } from "./workers/distance.worker.js";

async function start(): Promise<void> {
  const app = await buildApp();

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
    app.log.info(`Server running in ${env.NODE_ENV} mode`);

    // Phase 11: Deployment log marker — GITHUB_SHA is injected by GitHub Actions.
    // Allows operators to correlate a running container to an exact git commit.
    app.log.info(
      { version: process.env["GITHUB_SHA"] ?? "manual" },
      "Server booted",
    );

    // Phase 10: Crash recovery runs AFTER the server is fully listening.
    // Orphaned sessions are re-enqueued into Redis via BullMQ.
    // performStartupRecovery is non-blocking internally (setImmediate batching)
    // so this call returns almost immediately and enqueuing happens in the
    // background on subsequent event loop ticks.
    performStartupRecovery(app);
  } catch (error) {
    app.log.error(error, "Failed to start server");
    process.exit(1);
  }
}

start();
