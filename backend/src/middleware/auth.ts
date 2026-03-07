import type { FastifyRequest, FastifyReply } from "fastify";
import { trace, context } from "@opentelemetry/api";
import { jwtPayloadSchema } from "../types/jwt.js";
import { UnauthorizedError } from "../utils/errors.js";

/**
 * Authentication middleware — JWT verification + Zod payload validation.
 *
 * 1. Verifies JWT signature via @fastify/jwt
 * 2. Validates decoded claims against the strict Zod schema
 * 3. Attaches typed `user` and `organizationId` to the request
 *
 * Any request that fails verification or has malformed claims
 * is rejected with a 401 Unauthorized response.
 */
export async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    try {
        // Step 1: Verify JWT signature and decode payload
        await request.jwtVerify();

        // Step 2: Validate decoded payload structure with Zod
        const result = jwtPayloadSchema.safeParse(request.user);

        if (!result.success) {
            const issues = result.error.issues
                .map((issue) => issue.message)
                .join("; ");

            request.log.warn({ issues }, "JWT payload validation failed");

            const err = new UnauthorizedError(`Invalid token claims: ${issues}`);
            reply.status(err.statusCode).send({ error: err.message });
            return;
        }

        // Step 3: Attach validated tenant context to request
        request.organizationId = result.data.organization_id;

        // Attach the user's identity to the active trace span so every
        // downstream span in this request is automatically tagged with the
        // actor. Invaluable for debugging permission or data-isolation issues.
        const span = trace.getSpan(context.active());
        if (span) {
            span.setAttribute("enduser.id", result.data.sub);
        }
    } catch (_error) {
        const err = new UnauthorizedError(
            "Invalid or missing authentication token"
        );
        reply.status(err.statusCode).send({ error: err.message });
    }
}
