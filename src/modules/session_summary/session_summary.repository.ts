import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import { orgTable } from "../../db/query.js";
import type { TenantContext } from "../../utils/tenant.js";
import type { FastifyRequest } from "fastify";
import type { SessionSummary } from "./session_summary.schema.js";

/**
 * Session Summary repository — Supabase queries for session_summaries.
 *
 * Phase 16 confirmed column set:
 *   id, organization_id, session_id, total_distance_km,
 *   total_duration_seconds, avg_speed_kmh, computed_at
 *
 * organization_id is present on session_summaries — tenantQuery() is
 * therefore applied on reads for defense-in-depth.
 */
export const sessionSummaryRepository = {
    async upsertSummary(
        _context: TenantContext | FastifyRequest,
        summary: Omit<SessionSummary, "computed_at">,
    ): Promise<SessionSummary> {
        const computed_at = new Date().toISOString();

        const { data: record, error } = await supabase
            .from("session_summaries")
            .upsert(
                {
                    organization_id: summary.organization_id,
                    session_id: summary.session_id,
                    total_distance_km: summary.total_distance_km,
                    total_duration_seconds: summary.total_duration_seconds,
                    avg_speed_kmh: summary.avg_speed_kmh,
                    computed_at,
                },
                { onConflict: "session_id" },
            )
            .select("organization_id, session_id, total_distance_km, total_duration_seconds, avg_speed_kmh, computed_at")
            .single();

        if (error) {
            throw new Error(`Failed to upsert session summary: ${error.message}`);
        }
        return record as SessionSummary;
    },

    async getSummary(
        request: FastifyRequest,
        sessionId: string,
    ): Promise<SessionSummary | null> {
        const { data, error } = await orgTable(request, "session_summaries")
            .select("organization_id, session_id, total_distance_km, total_duration_seconds, avg_speed_kmh, computed_at")
            .eq("session_id", sessionId)
            .single();

        if (error && error.code === "PGRST116") return null;
        if (error) {
            throw new Error(`Failed to fetch session summary: ${error.message}`);
        }
        return data as SessionSummary;
    },
};
