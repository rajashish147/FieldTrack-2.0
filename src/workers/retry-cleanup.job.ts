import type { FastifyInstance } from "fastify";
import { cleanupResolvedRetryIntents } from "./retry-intents.js";

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const RETAIN_HOURS = 72;

export function startRetryIntentCleanupJob(app: FastifyInstance): void {
  const run = async (): Promise<void> => {
    await cleanupResolvedRetryIntents(app, RETAIN_HOURS);
  };

  void run();

  const timer = setInterval(() => {
    void run();
  }, CLEANUP_INTERVAL_MS);

  timer.unref();

  app.log.info(
    { intervalMs: CLEANUP_INTERVAL_MS, retainHours: RETAIN_HOURS },
    "Retry intent cleanup job started",
  );
}
