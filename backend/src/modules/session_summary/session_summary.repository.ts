import { supabase } from "../../config/supabase.js";
import { enforceTenant } from "../../utils/tenant.js";
import type { FastifyRequest } from "fastify";
import type { SessionSummary } from "./session_summary.schema.js";

/**
 * Session Summary repository — Supabase queries for the session_summaries table.
 * Operations are strictly tenant-isolated.
 */
export const sessionSummaryRepository = {
    /**
     * Upsert a session summary.
     * This is called when a session is checked out or explicitly recalculated.
     */
    async upsertSummary(
        _request: FastifyRequest,
        summary: Omit<SessionSummary, "updated_at">,
    ): Promise<SessionSummary> {
        const updated_at = new Date().toISOString();

        const { data: record, error } = await supabase
            .from("session_summaries")
            .upsert({
                ...summary,
                updated_at,
            }, { onConflict: "session_id" })
            .select("*")
            .single();

        if (error) {
            throw new Error(`Failed to upsert session summary: ${error.message}`);
        }
        return record as SessionSummary;
    },

    /**
     * Get summary for a specific session.
     */
    async getSummary(
        request: FastifyRequest,
        sessionId: string,
    ): Promise<SessionSummary | null> {
        const baseQuery = supabase
            .from("session_summaries")
            .select("*")
            .eq("session_id", sessionId);

        const { data, error } = await enforceTenant(request, baseQuery)
            .single();

        if (error && error.code === "PGRST116") {
            return null;
        }
        if (error) {
            throw new Error(`Failed to fetch session summary: ${error.message}`);
        }
        return data as SessionSummary;
    },
};
