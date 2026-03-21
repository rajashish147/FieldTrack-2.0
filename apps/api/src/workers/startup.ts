import type { FastifyInstance } from "fastify";

type RuntimeFlags = Partial<
  Record<"CI_MODE" | "CI" | "SKIP_EXTERNAL_SERVICES" | "NODE_ENV" | "APP_ENV", string>
>;

function isEnabled(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

/**
 * Centralized gate for background workers and recovery jobs.
 * Returns true only for real runtime mode where external dependencies are enabled.
 */
export function shouldStartWorkers(flags: RuntimeFlags = process.env): boolean {
  const skipExternalServices = isEnabled(flags.SKIP_EXTERNAL_SERVICES);
  const isCiMode = isEnabled(flags.CI_MODE) || isEnabled(flags.CI);
  const isTestEnv = flags.NODE_ENV === "test" || flags.APP_ENV === "test";

  return !skipExternalServices && !isCiMode && !isTestEnv;
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
  const [{ startDistanceWorker }, { startAnalyticsWorker }] = await Promise.all([
    import("./distance.worker.js"),
    import("./analytics.worker.js"),
  ]);

  startDistanceWorker(app);
  startAnalyticsWorker(app);
  workersStarted = true;
}
