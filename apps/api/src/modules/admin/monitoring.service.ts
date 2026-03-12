import type { FastifyRequest } from "fastify";
import { monitoringRepository } from "./monitoring.repository.js";
import { NotFoundError } from "../../utils/errors.js";
import type { AdminSession } from "../../types/db.js";
import { z } from "zod";

export const monitoringPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type MonitoringPaginationQuery = z.infer<typeof monitoringPaginationSchema>;

export const monitoringService = {
  async startMonitoring(request: FastifyRequest): Promise<AdminSession> {
    // Prevent duplicate clicks - return existing active session if any
    const active = await monitoringRepository.getActiveSession(request);
    if (active) {
      return active;
    }

    const session = await monitoringRepository.startSession(request);

    request.log.info(
      { event: "admin_monitoring_started", adminId: request.user.sub, sessionId: session.id },
      "Admin monitoring session started",
    );

    return session;
  },

  async stopMonitoring(request: FastifyRequest): Promise<AdminSession> {
    const session = await monitoringRepository.stopSession(request);

    if (!session) {
      throw new NotFoundError("No active monitoring session found. Start one first.");
    }

    request.log.info(
      { event: "admin_monitoring_stopped", adminId: request.user.sub, sessionId: session.id },
      "Admin monitoring session stopped",
    );

    return session;
  },

  async getHistory(
    request: FastifyRequest,
    page: number,
    limit: number,
  ): Promise<AdminSession[]> {
    return monitoringRepository.findHistory(request, page, limit);
  },
};
