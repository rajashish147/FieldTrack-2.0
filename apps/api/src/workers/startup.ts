import type { FastifyInstance } from "fastify";

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
}
