import type { FastifyRequest, FastifyReply } from "fastify";
import { analyticsService } from "./analytics.service.js";
import type {
  OrgSummaryQuery,
  UserSummaryQuery,
  TopPerformersQuery,
  SessionTrendQuery,
  LeaderboardQuery,
} from "./analytics.schema.js";
import { ok, handleError } from "../../utils/response.js";

/**
 * Analytics controller — delegates to service and returns consistent
 * { success, data } responses. Query parameter validation is handled by
 * Fastify + Zod at the route level (schema.querystring); no manual
 * re-parsing is performed here.
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
      const query = request.query as OrgSummaryQuery;
      const data = await analyticsService.getOrgSummary(
        request,
        query.from,
        query.to,
      );
      reply.status(200).send(ok(data));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error in getOrgSummary");
    }
  },

  /**
   * GET /admin/user-summary?userId=UUID&from=&to=
   * Per-user aggregate statistics for a date range.
   * When userId is omitted, defaults to the authenticated user's own ID.
   */
  async getUserSummary(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const query = request.query as UserSummaryQuery;
      const userId = query.userId ?? request.user.sub;
      const data = await analyticsService.getUserSummary(
        request,
        userId,
        query.from,
        query.to,
      );
      reply.status(200).send(ok(data));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error in getUserSummary");
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
      const query = request.query as TopPerformersQuery;
      const data = await analyticsService.getTopPerformers(
        request,
        query.metric,
        query.from,
        query.to,
        query.limit,
      );
      reply.status(200).send(ok(data));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error in getTopPerformers");
    }
  },

  /**
   * GET /admin/session-trend?from=&to=
   * Daily time-series of sessions, distance, and duration.
   */
  async getSessionTrend(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const query = request.query as SessionTrendQuery;
      const data = await analyticsService.getSessionTrend(
        request,
        query.from,
        query.to,
      );
      reply.status(200).send(ok(data));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error in getSessionTrend");
    }
  },

  /**
   * GET /admin/leaderboard?metric=distance|duration|sessions&from=&to=&limit=10
   * Full leaderboard with rank, employee_code, employee_name, and all metrics.
   */
  async getLeaderboard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const query = request.query as LeaderboardQuery;
      const data = await analyticsService.getLeaderboard(
        request,
        query.metric,
        query.from,
        query.to,
        query.limit,
      );
      reply.status(200).send(ok(data));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error in getLeaderboard");
    }
  },
};
