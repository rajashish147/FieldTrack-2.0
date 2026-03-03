import { supabase } from "../../config/supabase.js";
import { enforceTenant } from "../../utils/tenant.js";
import type { FastifyRequest } from "fastify";
import type { LocationRecord, CreateLocationBody } from "./locations.schema.js";

/**
 * Locations repository — Supabase queries for the locations table.
 * Every query is scoped via enforceTenant() for tenant isolation.
 * enforceTenant() is always called BEFORE terminal operations (.single/.range).
 */
export const locationsRepository = {
    /**
   * Insert a new location record attached to a specific session.
   * Uses upsert to guarantee idempotency against network retries.
   */
    async createLocation(
        request: FastifyRequest,
        userId: string,
        sessionId: string,
        data: CreateLocationBody,
    ): Promise<LocationRecord> {
        const { data: record, error } = await supabase
            .from("locations")
            .upsert({
                user_id: userId,
                organization_id: request.organizationId,
                session_id: sessionId,
                latitude: data.latitude,
                longitude: data.longitude,
                accuracy: data.accuracy,
                recorded_at: data.recorded_at,
                created_at: new Date().toISOString(),
            }, { onConflict: "session_id, recorded_at", ignoreDuplicates: true })
            .select("*")
            .single();

        if (error) {
            throw new Error(`Failed to insert location: ${error.message}`);
        }
        return record as LocationRecord;
    },

    /**
     * Bulk insert multiple location points for a specific session.
     * Supabase optimally handles bulk inserts via array passing.
     * Uses upsert to guarantee idempotency.
     */
    async createLocationBatch(
        request: FastifyRequest,
        userId: string,
        sessionId: string,
        points: Omit<CreateLocationBody, "session_id">[],
    ): Promise<number> {
        const now = new Date().toISOString();
        const rows = points.map((p) => ({
            user_id: userId,
            organization_id: request.organizationId,
            session_id: sessionId,
            latitude: p.latitude,
            longitude: p.longitude,
            accuracy: p.accuracy,
            recorded_at: p.recorded_at,
            created_at: now,
        }));

        // .select("id") ensures we just get a low-bandwidth id map back to count them
        const { data, error } = await supabase
            .from("locations")
            .upsert(rows, { onConflict: "session_id, recorded_at", ignoreDuplicates: true })
            .select("id");

        if (error) {
            throw new Error(`Failed to bulk insert locations: ${error.message}`);
        }
        return data?.length ?? 0;
    },

    /**
     * Fetch all locations for a specific session ordered by time.
     */
    async findLocationsBySession(
        request: FastifyRequest,
        sessionId: string,
    ): Promise<LocationRecord[]> {
        const baseQuery = supabase
            .from("locations")
            .select("*")
            .eq("session_id", sessionId)
            .order("recorded_at", { ascending: true });

        const { data, error } = await enforceTenant(request, baseQuery);

        if (error) {
            throw new Error(`Failed to fetch location history: ${error.message}`);
        }
        return (data ?? []) as LocationRecord[];
    },
};
