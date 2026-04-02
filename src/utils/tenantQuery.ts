import type { FastifyRequest } from "fastify";
import type { TenantContext } from "./tenant.js";

/**
 * Repository-facing tenant isolation wrapper.
 *
 * All repository files must use this function instead of calling
 * enforceTenant() directly. This boundary is enforced by ESLint
 * (see eslint.config.js: no-restricted-imports on enforceTenant).
 *
 * Accepts either a FastifyRequest (HTTP handlers) or a TenantContext
 * (background workers that carry organizationId without a full request).
 *
 * Usage:
 *   const { data, error } = await tenantQuery(request,
 *     supabase.from("attendance_sessions").select("*")
 *   );
 */
interface TenantScopable {
    eq(column: string, value: string): this;
}

export function tenantQuery<T extends TenantScopable>(
    context: TenantContext | FastifyRequest,
    query: T,
): T {
    const orgId = context.organizationId;

    if (!orgId) {
        throw new Error("Tenant enforcement failed: organizationId missing from context");
    }

    return query.eq("organization_id", orgId);
}
