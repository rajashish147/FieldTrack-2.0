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
     * Insert doesn't need enforceTenant() since org_id is explicitly set.
     */
    async createLocation(
        request: FastifyRequest,
        userId: string,
        sessionId: string,
        data: CreateLocationBody,
    ): Promise<LocationRecord> {
        const { data: record, error } = await supabase
            .from("locations")
            .insert({
                user_id: userId,
                organization_id: request.organizationId,
                session_id: sessionId,
                latitude: data.latitude,
                longitude: data.longitude,
                accuracy: data.accuracy,
                recorded_at: data.recorded_at,
                created_at: new Date().toISOString(),
            })
            .select("*")
            .single();

        if (error) {
            throw new Error(`Failed to insert location: ${error.message}`);
        }
        return record as LocationRecord;
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
