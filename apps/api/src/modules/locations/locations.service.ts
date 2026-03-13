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

    const record = await locationsRepository.createLocation(
      request,
      employeeId,
      body.session_id,
      body,
    );
    const latencyMs = Math.round(performance.now() - start);

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

    const insertedCount = await locationsRepository.createLocationBatch(
      request,
      employeeId,
      body.session_id,
      body.points,
    );

    const latencyMs = Math.round(performance.now() - start);
    const duplicatesSuppressed = body.points.length - insertedCount;

    metrics.incrementLocationsInserted(insertedCount);

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
