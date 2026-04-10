import type { FastifyRequest, FastifyReply } from "fastify";
import { ZodError } from "zod";
import { AppError } from "./errors.js";

// ─── Response shape types ─────────────────────────────────────────────────────
//
// DTO LAYER ENFORCEMENT:
// All API responses MUST use these builders — no raw DB rows returned directly.
// Controllers call ok(data) or paginated(data, page, limit, total).
// Repository layers transform DB rows into typed DTOs before returning.
// This ensures:
//   1. No internal DB column names leak to the API surface
//   2. Computed fields (activityStatus, etc.) are always present
//   3. Response shape is consistent across all endpoints
//

export type SuccessResponse<T> = { success: true; data: T };
export type ErrorResponse = {
  success: false;
  error: string;
  requestId: string;
  code?: string;
  details?: Record<string, unknown>;
};
export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;

// ─── Pagination metadata ───────────────────────────────────────────────────────

export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type PaginatedSuccessResponse<T> = {
  success: true;
  data: T[];
  pagination: PaginationMeta;
};

// ─── Builder helpers ──────────────────────────────────────────────────────────

export function paginated<T>(
  data: T[],
  page: number,
  limit: number,
  total: number,
): PaginatedSuccessResponse<T> {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return { success: true, data, pagination: { page, limit, total, totalPages } };
}

export function ok<T>(data: T): SuccessResponse<T> {
  return { success: true, data };
}

export function fail(
  error: string,
  requestId: string,
  code?: string,
  details?: Record<string, unknown>,
): ErrorResponse {
  return { success: false, error, requestId, code, details };
}

// ─── Unified error handler ────────────────────────────────────────────────────

/**
 * Maps thrown errors to typed HTTP responses.
 *
 * Priority:
 *  1. AppError subclasses  → their statusCode (400 / 401 / 403 / 404)
 *  2. ZodError             → 400 Validation failed
 *  3. Anything else        → 500 Internal server error (logged)
 *
 * Returns never to improve TypeScript flow analysis in controllers.
 */
export function handleError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
  context: string,
): never {
  if (error instanceof AppError) {
    void reply
      .status(error.statusCode)
      .send(fail(error.message, request.id, error.code, error.details));
    throw error;
  }

  if (error instanceof ZodError) {
    // Build field-specific details for developer-friendly debugging
    const fields = error.issues.map((i) => ({
      field: i.path.length > 0 ? i.path.join(".") : "input",
      message: i.message,
    }));
    const message = fields.map((f) => `${f.field}: ${f.message}`).join("; ");
    void reply
      .status(400)
      .send(fail(`Validation failed: ${message}`, request.id, "VALIDATION_ERROR", { fields }));
    throw error;
  }

  request.log.error({ err: error }, context);
  void reply.status(500).send(fail("Internal server error", request.id, "INTERNAL_ERROR"));
  throw error;
}
