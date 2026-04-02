/**
 * audit-log.routes.ts — GET /admin/audit-log
 *
 * Returns a paginated list of admin audit events from `public.admin_audit_log`.
 * Supports cursor-based pagination via `before` (ISO timestamp) and optional
 * filtering by `event` type.
 *
 * Auth: ADMIN role required.
 * Not worker-gated — pure DB (does not require Redis / BullMQ).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import { handleError } from "../../utils/response.js";

export async function auditLogRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/admin/audit-log",
    {
      schema: {
        tags: ["admin"],
        description: "Paginated admin audit log — lists privileged actions (ADMIN only).",
        querystring: z.object({
          limit:  z.coerce.number().int().min(1).max(200).default(50),
          before: z.string().datetime({ offset: true }).optional(),
          event:  z.string().optional(),
        }),
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const { limit, before, event } = request.query as {
          limit:  number;
          before?: string;
          event?:  string;
        };

        let query = supabase
          .from("admin_audit_log")
          .select("id, event, actor_id, organization_id, resource_type, resource_id, payload, created_at")
          .order("created_at", { ascending: false })
          .limit(limit);

        if (before) {
          query = query.lt("created_at", before);
        }

        if (event) {
          query = query.eq("event", event);
        }

        const { data, error } = await query;

        if (error) {
          throw new Error(`[audit-log] DB query failed: ${error.message}`);
        }

        reply.status(200).send({
          success: true,
          data:    data ?? [],
          count:   (data ?? []).length,
        });
      } catch (error) {
        handleError(error, request, reply, "Failed to fetch audit log");
      }
    },
  );
}
