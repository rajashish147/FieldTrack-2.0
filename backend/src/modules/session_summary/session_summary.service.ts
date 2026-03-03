import type { FastifyRequest } from "fastify";
import { sessionSummaryRepository } from "./session_summary.repository.js";
import { locationsRepository } from "../locations/locations.repository.js";
import { attendanceRepository } from "../attendance/attendance.repository.js";
import { calculateHaversineDistance } from "../../utils/distance.js";
import { NotFoundError } from "../../utils/errors.js";
import type { RecalculateResponse } from "./session_summary.schema.js";

/**
 * Session Summary service — core logic for the distance engine and calculating duration.
 */
export const sessionSummaryService = {
    /**
     * Perform a strict recalculation of the session summary distance and duration.
     * Can be invoked organically during check-out or via an explicit recalculation endpoint.
     */
    async calculateAndSave(
        request: FastifyRequest,
        sessionId: string,
    ): Promise<RecalculateResponse> {
        // 1. Fetch the exact session to ensure it belongs to the org
        const session = await attendanceRepository.getSessionById(request, sessionId);
        if (!session) {
            throw new NotFoundError("Attendance session not found");
        }

        // 2. Fetch the lightweight location points for this session
        const points = await locationsRepository.findPointsForDistance(request, sessionId);

        // 3. Compute Distance (Haversine)
        let totalDistanceMeters = 0;
        if (points.length >= 2) {
            for (let i = 0; i < points.length - 1; i++) {
                const p1 = points[i];
                const p2 = points[i + 1];
                totalDistanceMeters += calculateHaversineDistance(
                    p1.latitude,
                    p1.longitude,
                    p2.latitude,
                    p2.longitude,
                );
            }
        }

        // Round to 2 decimal places to avoid floating point chaos
        totalDistanceMeters = Math.round(totalDistanceMeters * 100) / 100;

        // 4. Compute Duration
        const checkInTime = new Date(session.check_in_at).getTime();
        const endBoundary = session.check_out_at
            ? new Date(session.check_out_at).getTime()
            : Date.now();

        const durationSeconds = Math.max(0, Math.floor((endBoundary - checkInTime) / 1000));
        const totalPoints = points.length;

        // 5. Upsert to database
        await sessionSummaryRepository.upsertSummary(request, {
            session_id: session.id,
            organization_id: session.organization_id,
            user_id: session.user_id,
            total_distance_meters: totalDistanceMeters,
            total_points: totalPoints,
            duration_seconds: durationSeconds,
        });

        request.log.info(
            {
                sessionId,
                userId: session.user_id,
                organizationId: session.organization_id,
                totalDistanceMeters,
                durationSeconds,
                totalPoints,
            },
            "Calculated and saved session summary",
        );

        return {
            session_id: session.id,
            total_distance_meters: totalDistanceMeters,
            duration_seconds: durationSeconds,
            total_points: totalPoints,
        };
    }
};
