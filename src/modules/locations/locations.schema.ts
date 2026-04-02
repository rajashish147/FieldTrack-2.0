import { z } from "zod";
import type { GpsLocation } from "../../types/db.js";

// ─── Database Row Type ───────────────────────────────────
// Phase 16 — confirmed final schema for gps_locations.
//
// organization_id is included for direct enforceTenant() filtering,
// avoiding a JOIN to attendance_sessions on every location query.
//
// Phase 18 Note: sequence_number is nullable by design during mobile app
// stabilization. All queries use ORDER BY recorded_at as the primary ordering,
// ensuring distance calculations remain correct regardless of sequence_number.
//
// Future Migration (post-mobile stabilization):
//   ALTER TABLE gps_locations ALTER COLUMN sequence_number SET NOT NULL;
//   ALTER TABLE gps_locations ADD CONSTRAINT check_sequence_positive CHECK (sequence_number > 0);

export type LocationRecord = GpsLocation;

// ─── Request Schemas ─────────────────────────────────────

const TWO_MINUTES_MS = 2 * 60 * 1000;

export const createLocationSchema = z.object({
    session_id: z.string().uuid("session_id must be a valid UUID"),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().min(0),
    recorded_at: z.string().datetime().refine((val) => {
        const recordedTime = new Date(val).getTime();
        const now = Date.now();
        return recordedTime <= now + TWO_MINUTES_MS;
    }, "recorded_at cannot be more than 2 minutes in the future"),
    /**
     * Optional client-side sequence counter for ordering GPS points within a session.
     * Must be a non-negative integer. Monotonic increase per session is expected but
     * not enforced here — the service layer validates against the session start time.
     *
     * TODO (post-mobile stabilisation): add DB NOT NULL + CHECK (sequence_number >= 0)
     */
    sequence_number: z.number().int().min(0, "sequence_number must be >= 0").optional(),
});

export type CreateLocationBody = z.infer<typeof createLocationSchema>;

export const createLocationBatchSchema = z.object({
    session_id: z.string().uuid("session_id must be a valid UUID"),
    points: z.array(createLocationSchema.omit({ session_id: true })).min(1).max(100),
}).refine((batch) => {
    // Soft-validate monotonic sequence_number ordering within the batch.
    // Only checked when all points supply sequence_number.
    const withSeq = batch.points.filter((p) => p.sequence_number !== undefined);
    if (withSeq.length !== batch.points.length) return true; // partial — skip
    for (let i = 1; i < withSeq.length; i++) {
        if (withSeq[i]!.sequence_number! < withSeq[i - 1]!.sequence_number!) return false;
    }
    return true;
}, "points must be in non-descending sequence_number order");

export type CreateLocationBatchBody = z.infer<typeof createLocationBatchSchema>;

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

export interface LocationBatchResponse {
    success: true;
    inserted: number;
}
