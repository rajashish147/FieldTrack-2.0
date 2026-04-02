import type { FastifyRequest, FastifyReply } from "fastify";
import { monitoringService, monitoringPaginationSchema } from "./monitoring.service.js";
import { ok, paginated, handleError } from "../../utils/response.js";

export const monitoringController = {
  async start(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const session = await monitoringService.startMonitoring(request);
      reply.status(201).send(ok(session));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error starting monitoring session");
    }
  },

  async stop(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const session = await monitoringService.stopMonitoring(request);
      reply.status(200).send(ok(session));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error stopping monitoring session");
    }
  },

  async history(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const parsed = monitoringPaginationSchema.parse(request.query);
      const result = await monitoringService.getHistory(request, parsed.page, parsed.limit);
      reply.status(200).send(paginated(result.data, parsed.page, parsed.limit, result.total));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error fetching monitoring history");
    }
  },
};
