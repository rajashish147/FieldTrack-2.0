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
