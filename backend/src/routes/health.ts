import type { FastifyInstance } from "fastify";

interface HealthResponse {
    status: string;
    timestamp: string;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
    app.get<{ Reply: HealthResponse }>("/health", async (_request, _reply) => {
        return {
            status: "ok",
            timestamp: new Date().toISOString(),
        };
    });
}
