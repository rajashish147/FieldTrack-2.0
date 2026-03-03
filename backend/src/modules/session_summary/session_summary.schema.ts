import { z } from "zod";

export const sessionSummarySchema = z.object({
    session_id: z.string().uuid(),
    organization_id: z.string().uuid(),
    user_id: z.string().uuid(),
    total_distance_meters: z.number().min(0),
    total_points: z.number().int().min(0),
    duration_seconds: z.number().int().min(0),
    updated_at: z.string().datetime(),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export interface RecalculateResponse {
    session_id: string;
    total_distance_meters: number;
    duration_seconds: number;
    total_points: number;
}
