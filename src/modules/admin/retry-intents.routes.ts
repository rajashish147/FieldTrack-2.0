import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import { handleError } from "../../utils/response.js";

// ─── Route registration ───────────────────────────────────────────────────────

/**
 * Phase 26: Admin retry-intents visibility endpoint.
 *
 * GET /admin/retry-intents?status=pending|failed&page=1&limit=50
 *
 * Returns paginated list of queue retry intents for operational monitoring.
 * Allows operators to inspect enqueue failures, retry states, and dead intents
 * without SQL access.
 *
 * Auth: ADMIN only (JWT + role check).
 * Rate-limited: 60 req/min per admin to prevent abuse.
 */
export async function adminRetryIntentsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/admin/retry-intents",
    {
      schema: {
        tags: ["admin"],
        querystring: z.object({
          status: z.enum(["pending", "failed", "dead", "all"]).default("pending"),
          page: z.number().int().min(1).default(1),
          limit: z.number().int().min(10).max(200).default(50),
        }),
        description:
          "List queue retry intents by status with pagination (ADMIN only). Useful for monitoring enqueue failures.",
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const query = z
          .object({
            status: z.enum(["pending", "failed", "dead", "all"]).default("pending"),
            page: z.number().int().min(1).default(1),
            limit: z.number().int().min(10).max(200).default(50),
          })
          .parse(request.query);

        const offset = (query.page - 1) * query.limit;

        // C1 fix: always scope to the authenticated admin's organization.
        // supabaseServiceClient bypasses RLS — tenant isolation is app-enforced here.
        // After migration 20260326000100_add_org_id_to_retry_intents.sql the column
        // exists as a proper FK, replacing the previous unfiltered (cross-tenant) query.
        let queryBuilder = supabase
          .from("queue_retry_intents")
          .select("id, queue_name, job_key, payload, status, retry_count, error_message, next_retry_at, created_at, updated_at", {
            count: "exact",
          })
          .eq("organization_id", request.organizationId)
          .order("updated_at", { ascending: false })
          .range(offset, offset + query.limit - 1);

        if (query.status !== "all") {
          queryBuilder = queryBuilder.eq("status", query.status);
        }

        const { data, count, error } = await queryBuilder;

        if (error) {
          request.log.error({ error: error.message }, "Failed to fetch retry intents");
          throw error;
        }

        const totalPages = count ? Math.ceil(count / query.limit) : 0;

        reply.status(200).send({
          success: true,
          data: data ?? [],
          pagination: {
            page: query.page,
            limit: query.limit,
            total: count ?? 0,
            totalPages,
          },
        });
      } catch (error) {
        handleError(error, request, reply, "Failed to fetch retry intents");
      }
    },
  );
}
