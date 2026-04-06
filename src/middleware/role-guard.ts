import type { FastifyRequest } from "fastify";
import type { JwtPayload } from "../types/jwt.js";
import { ForbiddenError } from "../utils/errors.js";

/**
 * Creates a preHandler hook that enforces a specific role.
 * Must be used AFTER the authenticate middleware.
 */
export function requireRole(role: JwtPayload["role"]) {
    return async (request: FastifyRequest): Promise<void> => {
        if (request.user.role !== role) {
            throw new ForbiddenError(`This action requires ${role} role`);
        }
    };
}

/**
 * Creates a preHandler hook that allows any of the given roles.
 * Use when both ADMIN and EMPLOYEE should access the same endpoint.
 */
export function requireAnyRole(...roles: JwtPayload["role"][]) {
    return async (request: FastifyRequest): Promise<void> => {
        if (!roles.includes(request.user.role)) {
            throw new ForbiddenError(
                `This action requires one of: ${roles.join(", ")}`,
            );
        }
    };
}

/**
 * preHandler hook that asserts the request has a resolved employee identity.
 * Use AFTER authenticate. Rejects ADMIN users and any token missing employee_id.
 *
 * This is the route-level equivalent of requireEmployeeContext() from utils/errors.ts.
 * Using it as a preHandler makes it impossible to forget the check in service code.
 */
export async function requireEmployeeHook(request: FastifyRequest): Promise<void> {
    if (!request.employeeId) {
        throw new ForbiddenError(
            "Employee context required. This endpoint is for employees only.",
        );
    }
}
