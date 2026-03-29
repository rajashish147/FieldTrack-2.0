import type { FastifyRequest } from "fastify";
import { locationsRepository } from "./locations.repository.js";
import { attendanceRepository } from "../attendance/attendance.repository.js";
import { BadRequestError, requireEmployeeContext } from "../../utils/errors.js";
import { metrics } from "../../utils/metrics.js";
import type {
  LocationRecord,
  CreateLocationBody,
  CreateLocationBatchBody,
} from "./locations.schema.js";
import { profileRepository } from "../profile/profile.repository.js";
import { enqueueLocationUpdate } from "../../workers/snapshot.queue.js";

import { performance } from "perf_hooks";

/**
 * Location service — business logic for ingesting and retrieving locations.
 * requireEmployeeContext() asserts employee identity and narrows the type.
 */
export const locationsService = {
  async recordLocation(
    request: FastifyRequest,
    body: CreateLocationBody,
  ): Promise<LocationRecord> {
    const start = performance.now();
    requireEmployeeContext(request);
    const { employeeId } = request;

    const isValid = await attendanceRepository.validateSessionActive(
      request,
      body.session_id,
      employeeId,
    );

    if (!isValid) {
      throw new BadRequestError(
        "Cannot record location: invalid or closed attendance session.",
      );
    }

    // Reject points recorded before the session started (replay / clock-skew guard).
    const checkinAt = await attendanceRepository.getSessionCheckinAt(request, body.session_id);
    if (checkinAt && new Date(body.recorded_at) < new Date(checkinAt)) {
      throw new BadRequestError(
        "Cannot record location: recorded_at is before the session start time.",
      );
    }

    const record = await locationsRepository.createLocation(
      request,
      employeeId,
      body.session_id,
      body,
    );
    const latencyMs = Math.round(performance.now() - start);

    // Update last_activity_at (fire-and-forget)
    profileRepository.updateLastActivity(request, employeeId).catch(() => {});

    // feat-1: update snapshot with latest GPS fix (fire-and-forget, non-blocking)
    enqueueLocationUpdate({
      employeeId,
      organizationId: request.organizationId,
      sessionId: body.session_id,
      latitude: body.latitude,
      longitude: body.longitude,
      recordedAt: body.recorded_at,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      request.log.warn({ sessionId: body.session_id, error: msg }, "feat-1: failed to enqueue LOCATION_UPDATE snapshot job (non-fatal)");
    });

    metrics.incrementLocationsInserted(1);

    request.log.info(
      {
        userId: request.user.sub,
        employeeId,
        organizationId: request.organizationId,
        sessionId: body.session_id,
        latencyMs,
      },
      "Ingested new location point",
    );

    return record;
  },

  async recordLocationBatch(
    request: FastifyRequest,
    body: CreateLocationBatchBody,
  ): Promise<number> {
    const start = performance.now();
    requireEmployeeContext(request);
    const { employeeId } = request;

    const isValid = await attendanceRepository.validateSessionActive(
      request,
      body.session_id,
      employeeId,
    );

    if (!isValid) {
      throw new BadRequestError(
        "Cannot record locations: invalid or closed attendance session.",
      );
    }

    // Reject any point recorded before the session started.
    const checkinAt = await attendanceRepository.getSessionCheckinAt(request, body.session_id);
    if (checkinAt) {
      const sessionStart = new Date(checkinAt);
      const offender = body.points.find((p) => new Date(p.recorded_at) < sessionStart);
      if (offender) {
        throw new BadRequestError(
          "Cannot record locations: one or more points have recorded_at before the session start time.",
        );
      }
    }

    const insertedCount = await locationsRepository.createLocationBatch(
      request,
      employeeId,
      body.session_id,
      body.points,
    );

    const latencyMs = Math.round(performance.now() - start);
    const duplicatesSuppressed = body.points.length - insertedCount;

    metrics.incrementLocationsInserted(insertedCount);

    // Update last_activity_at (fire-and-forget — lightweight, no analytics tables touched)
    profileRepository.updateLastActivity(request, employeeId).catch(() => {});

    // feat-1: update snapshot with the latest GPS fix in the batch (fire-and-forget)
    const latestPoint = body.points.reduce((latest, p) =>
      new Date(p.recorded_at) > new Date(latest.recorded_at) ? p : latest,
    );
    enqueueLocationUpdate({
      employeeId,
      organizationId: request.organizationId,
      sessionId: body.session_id,
      latitude: latestPoint.latitude,
      longitude: latestPoint.longitude,
      recordedAt: latestPoint.recorded_at,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      request.log.warn({ sessionId: body.session_id, error: msg }, "feat-1: failed to enqueue LOCATION_UPDATE snapshot job (non-fatal)");
    });

    request.log.info(
      {
        userId: request.user.sub,
        employeeId,
        organizationId: request.organizationId,
        sessionId: body.session_id,
        insertedCount,
        duplicatesSuppressed,
        latencyMs,
      },
      "Ingested batch of location points",
    );

    return insertedCount;
  },

  async getRoute(
    request: FastifyRequest,
    sessionId: string,
  ): Promise<LocationRecord[]> {
    const result = await locationsRepository.findLocationsBySession(
      request,
      sessionId,
      request.employeeId,
    );
    return result ?? [];
  },
};
