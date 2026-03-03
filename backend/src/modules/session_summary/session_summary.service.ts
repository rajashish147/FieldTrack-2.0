import type { FastifyRequest } from "fastify";
import { sessionSummaryRepository } from "./session_summary.repository.js";
import { locationsRepository } from "../locations/locations.repository.js";
import { attendanceRepository } from "../attendance/attendance.repository.js";
import { calculateHaversineDistance } from "../../utils/distance.js";
import { NotFoundError } from "../../utils/errors.js";
import type { RecalculateResponse } from "./session_summary.schema.js";

import { performance } from "perf_hooks";
import { supabase } from "../../config/supabase.js";

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
        const start_time = performance.now();

        // 1. Fetch the exact session to ensure it belongs to the org
        const session = await attendanceRepository.getSessionById(request, sessionId);
        if (!session) {
            throw new NotFoundError("Attendance session not found");
        }

        // 2 & 3. Stream points in chunks and calculate distance cumulatively
        let totalDistanceMeters = 0;
        let totalPoints = 0;

        const CHUNK_SIZE = 1000;
        let page = 1;
        let hasMore = true;

        // Keep track of the last point of the PREVIOUS chunk to link paths across boundaries
        let lastPointFromPreviousChunk: { latitude: number; longitude: number; recorded_at: string } | null = null;

        while (hasMore) {
            const pointsChunk = await locationsRepository.findPointsForDistancePaginated(
                request,
                sessionId,
                page,
                CHUNK_SIZE
            );

            if (pointsChunk.length === 0) {
                hasMore = false;
                break;
            }

            totalPoints += pointsChunk.length;

            // If we have a trailing point from the last chunk, prepend it computationally 
            // for the first distance step of THIS chunk so we don't snap the route line.
            let i = 0;
            if (lastPointFromPreviousChunk && pointsChunk.length > 0) {
                totalDistanceMeters += calculateHaversineDistance(
                    lastPointFromPreviousChunk.latitude,
                    lastPointFromPreviousChunk.longitude,
                    pointsChunk[0].latitude,
                    pointsChunk[0].longitude,
                );
            }

            // Normal chunk iteration
            for (; i < pointsChunk.length - 1; i++) {
                const p1 = pointsChunk[i];
                const p2 = pointsChunk[i + 1];
                totalDistanceMeters += calculateHaversineDistance(
                    p1.latitude,
                    p1.longitude,
                    p2.latitude,
                    p2.longitude,
                );
            }

            // Save the absolute last point of this chunk explicitly for the next loop
            lastPointFromPreviousChunk = pointsChunk[pointsChunk.length - 1];

            // If we received fewer points than the CHUNK_SIZE limit, we are at the end.
            if (pointsChunk.length < CHUNK_SIZE) {
                hasMore = false;
            } else {
                page++;
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

        // Phase 6: Streaming execution latency
        const executionTimeMs = Math.round(performance.now() - start_time);

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
                executionTimeMs,
            },
            "Calculated and saved session summary",
        );

        return {
            session_id: session.id,
            total_distance_meters: totalDistanceMeters,
            duration_seconds: durationSeconds,
            total_points: totalPoints,
        };
    },

    /**
     * Internal generic method designed for background workers.
     * Takes a FastifyInstance for logging instead of a FastifyRequest.
     * Extracts tenant execution boundary explicitly.
     */
    async calculateAndSaveSystem(
        fastifyApp: any,
        sessionId: string,
    ): Promise<RecalculateResponse> {
        // Create a mocked request object that enforceTenant can use
        // This is safe because the worker loop only processes validated closed sessions
        const mockRequest = {
            log: fastifyApp.log,
            // To be completely safe with your tenant enforcement architecture
            // we should technically load the session first as super-admin (service role)
            // But since `enforceTenant` needs `request.organizationId`, we will read it manually first
        } as any;

        const { data: sessionData, error: sessionErr } = await supabase
            .from("attendance_sessions")
            .select("*")
            .eq("id", sessionId)
            .single();

        if (sessionErr || !sessionData) {
            fastifyApp.log.error(`Worker failed to find session: ${sessionId}`);
            throw new NotFoundError("Attendance session not found");
        }

        mockRequest.organizationId = sessionData.organization_id;

        const start_time = performance.now();

        // 2 & 3. Stream points in chunks and calculate distance cumulatively
        let totalDistanceMeters = 0;
        let totalPoints = 0;

        const CHUNK_SIZE = 1000;
        let page = 1;
        let hasMore = true;

        let lastPointFromPreviousChunk: { latitude: number; longitude: number; recorded_at: string } | null = null;

        while (hasMore) {
            const pointsChunk = await locationsRepository.findPointsForDistancePaginated(
                mockRequest,
                sessionId,
                page,
                CHUNK_SIZE
            );

            if (pointsChunk.length === 0) {
                hasMore = false;
                break;
            }

            totalPoints += pointsChunk.length;

            let i = 0;
            if (lastPointFromPreviousChunk && pointsChunk.length > 0) {
                totalDistanceMeters += calculateHaversineDistance(
                    lastPointFromPreviousChunk.latitude,
                    lastPointFromPreviousChunk.longitude,
                    pointsChunk[0].latitude,
                    pointsChunk[0].longitude,
                );
            }

            for (; i < pointsChunk.length - 1; i++) {
                const p1 = pointsChunk[i];
                const p2 = pointsChunk[i + 1];
                totalDistanceMeters += calculateHaversineDistance(
                    p1.latitude,
                    p1.longitude,
                    p2.latitude,
                    p2.longitude,
                );
            }

            lastPointFromPreviousChunk = pointsChunk[pointsChunk.length - 1];

            if (pointsChunk.length < CHUNK_SIZE) {
                hasMore = false;
            } else {
                page++;
            }
        }

        totalDistanceMeters = Math.round(totalDistanceMeters * 100) / 100;

        const checkInTime = new Date(sessionData.check_in_at).getTime();
        const endBoundary = sessionData.check_out_at
            ? new Date(sessionData.check_out_at).getTime()
            : Date.now();

        const durationSeconds = Math.max(0, Math.floor((endBoundary - checkInTime) / 1000));

        const executionTimeMs = Math.round(performance.now() - start_time);

        await sessionSummaryRepository.upsertSummary(mockRequest, {
            session_id: sessionData.id,
            organization_id: sessionData.organization_id,
            user_id: sessionData.user_id,
            total_distance_meters: totalDistanceMeters,
            total_points: totalPoints,
            duration_seconds: durationSeconds,
        });

        fastifyApp.log.info(
            {
                sessionId,
                userId: sessionData.user_id,
                organizationId: sessionData.organization_id,
                totalDistanceMeters,
                durationSeconds,
                totalPoints,
                executionTimeMs,
                source: "background_worker"
            },
            "Asynchronously calculated and saved session summary",
        );

        return {
            session_id: sessionData.id,
            total_distance_meters: totalDistanceMeters,
            duration_seconds: durationSeconds,
            total_points: totalPoints,
        };
    }
};
