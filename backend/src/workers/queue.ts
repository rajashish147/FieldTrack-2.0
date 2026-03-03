import { sessionSummaryService } from "../modules/session_summary/session_summary.service.js";

// In-memory queue. In production, replace with Redis (BullMQ/agenda).
const queue: string[] = [];

// Track currently processing sessions to prevent duplicate concurrent calculations
export const processingTracker = new Set<string>();

/**
 * Push a session into the async recalculation queue.
 * Returns immediately.
 */
export function enqueueDistanceRecalculation(sessionId: string): void {
    if (processingTracker.has(sessionId) || queue.includes(sessionId)) {
        // Already in queue or processing, skip to avoid redundant work
        return;
    }
    queue.push(sessionId);
}

/**
 * Worker loop that perpetually processes the queue in the background.
 */
export async function startDistanceWorker(fastifyApp: any): Promise<void> {
    fastifyApp.log.info("Started Background Distance Worker Loop");

    // Infinite background loop
    while (true) {
        if (queue.length === 0) {
            // Sleep for 2 seconds before checking again if empty
            await new Promise((resolve) => setTimeout(resolve, 2000));
            continue;
        }

        const sessionId = queue.shift();
        if (!sessionId) continue;

        processingTracker.add(sessionId);

        try {
            // Generate a mock request object just to pass the logger via fastifyApp
            // A full FastifyRequest is hard to mock, so we adapt the service to accept
            // a logger and organizationId directly, or we create a minimalist mock.
            // Since `calculateAndSave` expects a full FastifyRequest just for tenant enforcement:

            // Let's call a worker-specific recalculate service that doesn't need FastifyRequest
            await sessionSummaryService.calculateAndSaveSystem(fastifyApp, sessionId);

        } catch (error: any) {
            fastifyApp.log.error(
                { sessionId, error: error.message },
                "Background distance calculation failed"
            );
        } finally {
            processingTracker.delete(sessionId);
        }
    }
}
