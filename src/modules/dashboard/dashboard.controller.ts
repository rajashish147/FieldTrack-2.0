import type { FastifyRequest, FastifyReply } from "fastify";
import { dashboardService } from "./dashboard.service.js";
import { ok, handleError } from "../../utils/response.js";

export const dashboardController = {
  async getMySummary(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const summary = await dashboardService.getMySummary(request);
      reply.status(200).send(ok(summary));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error fetching dashboard summary");
    }
  },
};
