import type { FastifyRequest, FastifyReply } from "fastify";
import { trace, context } from "@opentelemetry/api";
import { validate as uuidValidate } from "uuid";
import { jwtPayloadSchema } from "../types/jwt.js";
import { AppError, UnauthorizedError } from "../utils/errors.js";
import { fail } from "../utils/response.js";
import { verifySupabaseToken } from "../auth/jwtVerifier.js";

/**
 * Layer 2 — Authentication Middleware
 *
 * Fastify preHandler that authenticates incoming requests via Supabase JWKS (ES256).
 *
 * JWT is the ONLY source of truth for identity and authorization.
 * No database fallback. No user_metadata lookups. No Redis fallback.
 *
 * Required JWT claims:
 *   ALL users:  role, org_id
 *   EMPLOYEE:   employee_id (additionally required)
 *
 * Missing claims → 401 immediately. No fallback logic.
 */
export async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    try {
        const authHeader = request.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            throw new UnauthorizedError("Missing or malformed Authorization header");
        }

        const token = authHeader.substring(7);

        // Verify ES256 signature via Supabase JWKS endpoint.
        const decoded = await verifySupabaseToken(token);

        const userId = decoded.sub;
        const email  = decoded.email;

        // Validate UUID format for sub to stop malformed tokens early.
        if (!uuidValidate(userId)) {
            request.log.warn({ sub: userId }, "Invalid user ID format in token");
            throw new UnauthorizedError("Invalid user id in token");
        }

        // Phase 28a: JWT claims are TOP-LEVEL only.
        // Migration from Phase 5 (app_metadata) is complete — only top-level claims are valid.
        // user_metadata is user-editable and MUST NOT be used for authz.
        const role           = decoded.role;
        const organizationId = decoded.org_id;
        const hookEmployeeId = decoded.employee_id;

        if (!role || !organizationId) {
            request.log.warn(
                {
                    sub: decoded.sub,
                    hasRole:  !!decoded.role,
                    hasOrgId: !!decoded.org_id,
                    claimSource: "none",
                },
                "JWT missing required claims (role, org_id) — Supabase auth hook may not be enabled",
            );
            throw new AppError(
                "JWT missing required claims",
                401,
                "AUTH_HOOK_MISSING",
                { hint: "Check Supabase Auth Hook: Dashboard → Authentication → Hooks → Customize Access Token (JWT) Claims" },
            );
        }

        // EMPLOYEE role requires employee_id in the JWT.
        // No fallback to DB — if the hook did not inject it the request is rejected.
        if (role === "EMPLOYEE" && !hookEmployeeId) {
            request.log.warn(
                { sub: decoded.sub, role },
                "JWT missing employee_id for EMPLOYEE role",
            );
            throw new AppError(
                "JWT missing employee_id claim for EMPLOYEE role",
                401,
                "AUTH_HOOK_MISSING",
                { hint: "Verify the employee record exists in public.employees and the auth hook is enabled" },
            );
        }

        // Validate complete user context with Zod.
        const result = jwtPayloadSchema.safeParse({
            sub: userId,
            email,
            role,
            organization_id: organizationId,
        });

        if (!result.success) {
            const issues = result.error.issues
                .map((issue) => issue.message)
                .join("; ");

            request.log.warn({ issues }, "JWT payload validation failed");

            const err = new UnauthorizedError(`Invalid token claims: ${issues}`);
            reply.status(err.statusCode).send(fail(err.message, request.id));
            return;
        }

        // Attach authenticated user and resolved employee id to request.
        request.user           = result.data;
        request.organizationId = result.data.organization_id;
        request.employeeId     = hookEmployeeId ?? undefined;

        const span = trace.getSpan(context.active());
        if (span) {
            span.setAttribute("enduser.id",   result.data.sub);
            span.setAttribute("enduser.role",  result.data.role);
        }
    } catch (error) {
        const err = error instanceof AppError
            ? error
            : new UnauthorizedError("Invalid or missing authentication token");

        void reply.status(err.statusCode).send(fail(err.message, request.id, (err as AppError).code, (err as AppError).details));
        return;
    }
}


