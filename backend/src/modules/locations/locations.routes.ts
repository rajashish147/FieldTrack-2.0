import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { locationsController } from "./locations.controller.js";

/**
 * Location routes — endpoints for ingesting and retrieving GPS tracks.
 */
export async function locationsRoutes(app: FastifyInstance): Promise<void> {
    // Ingest location — EMPLOYEE only
    app.post("/locations", {
        preHandler: [authenticate, requireRole("EMPLOYEE")],
    }, locationsController.recordLocation);

    // Retrieve route — specific session history (EMPLOYEE)
    app.get("/locations/my-route", {
        preHandler: [authenticate, requireRole("EMPLOYEE")],
    }, locationsController.getRoute);
}
