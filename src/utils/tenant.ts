import type { FastifyRequest } from "fastify";

/**
 * Phase 18: Minimal context required for tenant isolation.
 * Used by both HTTP request handlers and background workers.
 */
export interface TenantContext {
    organizationId: string;
}

/**
 * Enforces tenant isolation by scoping a Supabase query to the
 * authenticated user's organization_id.
 *
 * Uses a structural type that matches Supabase's query builder
 * without importing its complex generic chain.
 *
 * Accepts either a full FastifyRequest or a minimal TenantContext,
 * allowing both HTTP handlers and background workers to use the same
 * tenant isolation logic.
 *
 * Usage:
 *   const query = supabase.from("expenses").select("*");
 *   const { data, error } = await enforceTenant(request, query);
 */
interface TenantScopable {
    eq(column: string, value: string): this;
}

export function enforceTenant<T extends TenantScopable>(
    context: TenantContext | FastifyRequest,
    query: T,
): T {
    const orgId = context.organizationId;
    
    if (!orgId) {
        throw new Error("Tenant enforcement failed: organizationId missing from context");
    }
    
    return query.eq("organization_id", orgId);
}
