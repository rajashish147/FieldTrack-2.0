import type { FastifyRequest, FastifyReply } from "fastify";
import { analyticsService } from "./analytics.service.js";
import {
  orgSummaryQuerySchema,
  userSummaryQuerySchema,
  topPerformersQuerySchema,
} from "./analytics.schema.js";
import { AppError } from "../../utils/errors.js";

/**
 * Analytics controller — validates query params via Zod, delegates to service,
 * returns consistent { success, data } responses.
 *
 * All handlers catch AppError subclasses (BadRequestError, NotFoundError, etc.)
 * and map them to typed HTTP responses. Unexpected errors return 500.
 */
export const analyticsController = {
  /**
   * GET /admin/org-summary?from=&to=
   * Organisation-wide aggregate statistics for a date range.
   */
  async getOrgSummary(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const parsed = orgSummaryQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => i.message).join("; ");
        reply.status(400).send({ error: `Validation failed: ${issues}` });
        return;
      }

      const data = await analyticsService.getOrgSummary(
        request,
        parsed.data.from,
        parsed.data.to,
      );

      reply.status(200).send({ success: true, data });
    } catch (error) {
      if (error instanceof AppError) {
        reply.status(error.statusCode).send({ error: error.message });
        return;
      }
      request.log.error(error, "Unexpected error in getOrgSummary");
      reply.status(500).send({ error: "Internal server error" });
    }
  },

  /**
   * GET /admin/user-summary?userId=UUID&from=&to=
   * Per-user aggregate statistics for a date range.
   */
  async getUserSummary(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const parsed = userSummaryQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => i.message).join("; ");
        reply.status(400).send({ error: `Validation failed: ${issues}` });
        return;
      }

      const data = await analyticsService.getUserSummary(
        request,
        parsed.data.userId,
        parsed.data.from,
        parsed.data.to,
      );

      reply.status(200).send({ success: true, data });
    } catch (error) {
      if (error instanceof AppError) {
        reply.status(error.statusCode).send({ error: error.message });
        return;
      }
      request.log.error(error, "Unexpected error in getUserSummary");
      reply.status(500).send({ error: "Internal server error" });
    }
  },

  /**
   * GET /admin/top-performers?metric=distance|duration|sessions&from=&to=&limit=10
   * Ranked leaderboard by the chosen metric.
   */
  async getTopPerformers(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const parsed = topPerformersQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => i.message).join("; ");
        reply.status(400).send({ error: `Validation failed: ${issues}` });
        return;
      }

      const data = await analyticsService.getTopPerformers(
        request,
        parsed.data.metric,
        parsed.data.from,
        parsed.data.to,
        parsed.data.limit,
      );

      reply.status(200).send({ success: true, data });
    } catch (error) {
      if (error instanceof AppError) {
        reply.status(error.statusCode).send({ error: error.message });
        return;
      }
      request.log.error(error, "Unexpected error in getTopPerformers");
      reply.status(500).send({ error: "Internal server error" });
    }
  },
};
