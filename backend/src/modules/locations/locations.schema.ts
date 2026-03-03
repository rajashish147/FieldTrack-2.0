import { z } from "zod";

// ─── Database Row Type ───────────────────────────────────

export interface LocationRecord {
    id: string;
    user_id: string;
    organization_id: string;
    session_id: string;
    latitude: number;
    longitude: number;
    accuracy: number;
    recorded_at: string;
    created_at: string;
}

// ─── Request Schemas ─────────────────────────────────────

// Two minutes in milliseconds for recorded_at validation
const TWO_MINUTES_MS = 2 * 60 * 1000;

export const createLocationSchema = z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().min(0),
    recorded_at: z.string().datetime().refine((val) => {
        const recordedTime = new Date(val).getTime();
        const now = Date.now();
        // Cannot be more than 2 minutes in the future
        return recordedTime <= now + TWO_MINUTES_MS;
    }, "recorded_at cannot be more than 2 minutes in the future"),
});

export type CreateLocationBody = z.infer<typeof createLocationSchema>;

export const sessionQuerySchema = z.object({
    sessionId: z.string().uuid("sessionId must be a valid UUID"),
});

export type SessionQuery = z.infer<typeof sessionQuerySchema>;

// ─── Response Types ──────────────────────────────────────

export interface LocationResponse {
    success: true;
    data: LocationRecord;
}

export interface LocationListResponse {
    success: true;
    data: LocationRecord[];
}
