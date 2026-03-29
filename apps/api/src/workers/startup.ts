import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";

// ─── Worker registry ──────────────────────────────────────────────────────────

/**
 * Canonical list of all background worker types.
 * Adding a new worker here automatically propagates the expected count to
 * /ready, /admin/system-health, and all boot logs — no manual number updates.
 */
export const WORKER_TYPES = ["distance", "analytics", "webhook", "snapshot"] as const;
export type WorkerType = (typeof WORKER_TYPES)[number];

/** Expected number of background workers in a fully-started process. */
export function getExpectedWorkerCount(): number {
  return WORKER_TYPES.length;
}

/**
 * Overrides accepted by shouldStartWorkers() for unit-test injection.
 * Production code always calls shouldStartWorkers() with no arguments.
 */
interface WorkerEnvOverrides {
  WORKERS_ENABLED?: boolean;
  APP_ENV?: string;
  NODE_ENV?: string;
}

/**
 * Centralized gate for background workers and recovery jobs.
 *
 * Returns true only when:
 *  - WORKERS_ENABLED=true  (Redis and BullMQ are provisioned in this environment)
 *  - APP_ENV is not "test"  (prevents accidental worker starts during unit tests)
 *
 * Infrastructure availability table:
 *   Production: WORKERS_ENABLED=true  → workers start  ✅
 *   Staging:    WORKERS_ENABLED=true  → workers start  ✅
 *   CI:         WORKERS_ENABLED unset → workers skip   ✅  (no Redis in CI)
 *   Local dev:  WORKERS_ENABLED=true if Redis available
 *
 * @param _overrides - Optional env overrides for unit-test injection only.
 *                     Production callers always omit this parameter.
 */
export function shouldStartWorkers(_overrides?: WorkerEnvOverrides): boolean {
  const workersEnabled = _overrides?.WORKERS_ENABLED ?? env.WORKERS_ENABLED;
  const appEnv  = _overrides?.APP_ENV  ?? env.APP_ENV;
  const nodeEnv = _overrides?.NODE_ENV ?? env.NODE_ENV;
  const isTest = appEnv === "test" || nodeEnv === "test";
  return workersEnabled && !isTest;
}

let workersStarted = false;

export function areWorkersStarted(): boolean {
  return workersStarted;
}

/**
 * Starts background workers explicitly from server bootstrap.
 * This keeps worker lifecycle out of module-import side effects.
 */
export async function startWorkers(app: FastifyInstance): Promise<void> {
  const [
    { startDistanceWorker },
    { startAnalyticsWorker },
    { startWebhookWorker },
    { startSnapshotWorker },
  ] = await Promise.all([
    import("./distance.worker.js"),
    import("./analytics.worker.js"),
    import("./webhook.worker.js"),
    import("./snapshot.worker.js"),
  ]);

  startDistanceWorker(app);
  startAnalyticsWorker(app);
  startWebhookWorker(app);
  startSnapshotWorker(app);
  workersStarted = true;
}
