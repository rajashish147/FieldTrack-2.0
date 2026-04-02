import { z } from "zod";

// Phase 16 — confirmed final schema for session_summaries:
//   id, organization_id, session_id, total_distance_km,
//   total_duration_seconds, avg_speed_kmh, computed_at
//
// organization_id is included for direct tenant-scoped analytics queries,
// avoiding JOIN to attendance_sessions on every analytics read.

export const sessionSummarySchema = z.object({
    organization_id: z.string().uuid(),
    session_id: z.string().uuid(),
    total_distance_km: z.number().min(0),
    total_duration_seconds: z.number().int().min(0),
    avg_speed_kmh: z.number().min(0),
    computed_at: z.string().datetime(),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export interface RecalculateResponse {
    session_id: string;
    total_distance_km: number;
    total_duration_seconds: number;
}
