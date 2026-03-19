import type { FastifyRequest, FastifyReply } from "fastify";
import { trace, context } from "@opentelemetry/api";
import { validate as uuidValidate } from "uuid";
import { jwtPayloadSchema } from "../types/jwt.js";
import { UnauthorizedError } from "../utils/errors.js";
import { fail } from "../utils/response.js";
import { verifySupabaseToken } from "../auth/jwtVerifier.js";
import { supabaseServiceClient } from "../config/supabase.js";
import { getCached } from "../utils/cache.js";
import { env } from "../config/env.js";

/**
 * Layer 2 — Authentication Middleware
 *
 * Fastify preHandler that authenticates incoming requests.
 *
 * Phase 20: Updated to use Supabase JWKS verification (ES256) in production.
 * In test mode, falls back to @fastify/jwt for compatibility with test tokens.
 *
 * Responsibilities:
 * 1. Extract token from Authorization header
 * 2. Verify token signature (delegates to Layer 1)
 * 3. Load user data from database
 * 4. Validate complete user context
 * 5. Attach authenticated user to request
 *
 * This middleware handles HTTP-specific concerns (headers, responses)
 * while Layer 1 (verifySupabaseToken) handles pure token verification.
 *
 * Any request that fails verification or has malformed claims
 * is rejected with a 401 Unauthorized response.
 */
export async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    try {
        // Step 1: Extract token from Authorization header
        const authHeader = request.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            throw new UnauthorizedError("Missing or malformed Authorization header");
        }

        const token = authHeader.substring(7); // Remove "Bearer " prefix

        let userId: string;
        let email: string | undefined;
        let role: string | undefined;
        let organizationId: string | undefined;

        // Step 2: Verify token signature (Layer 1)
        // In test mode (APP_ENV=test), use @fastify/jwt for backward compatibility
        // In production, use Supabase JWKS verification
        if (env.APP_ENV === "test") {
            // Test mode: use @fastify/jwt (synchronous verification)
            try {
                const decoded = request.server.jwt.verify(token) as any;
                userId = decoded.sub;
                role = decoded.role; // Test tokens have role at top level
                email = decoded.email;
                organizationId = decoded.organization_id;
                // Test tokens embed employee_id directly to avoid a DB call in tests.
                // signEmployeeToken includes it; ADMIN tokens omit it → undefined.
                // Guard: employee_id embedding is only valid in test mode.
                // Uses the centralized env.APP_ENV so all environment checks
                // flow through the validated config — no raw process.env access.
                if (env.APP_ENV === "test") {
                    request.employeeId = decoded.employee_id ?? undefined;
                }
            } catch (error) {
                throw new UnauthorizedError("Invalid or expired token");
            }
        } else {
            // Production mode: use Supabase JWKS verification (Layer 1)
            const decoded = await verifySupabaseToken(token);

            userId = decoded.sub;
            email = decoded.email;

            // Improvement 2: Validate UUID format for sub
            // Protects against malformed tokens with invalid user IDs
            if (!uuidValidate(userId)) {
                request.log.warn({ sub: userId }, "Invalid user ID format in token");
                throw new UnauthorizedError("Invalid user id in token");
            }

            // Improvement 1: Fail fast if user_metadata.role is missing
            // Never default roles - failing fast is safer than privilege mistakes
            role = decoded.user_metadata?.role;

            if (!role) {
                request.log.warn({ sub: decoded.sub }, "User role missing in token metadata");
                throw new UnauthorizedError("User role missing in token metadata");
            }

            // Phase 5: Short-circuit DB lookup if org identity is embedded in
            // the JWT via the custom_access_token_hook. Tokens minted before
            // the hook was deployed fall back to the Redis-cached DB lookup.
            const embeddedOrgId = (decoded.app_metadata as Record<string, unknown> | undefined)?.organization_id as string | undefined;
            const embeddedEmployeeId = (decoded.app_metadata as Record<string, unknown> | undefined)?.employee_id as string | undefined;

            if (embeddedOrgId) {
                organizationId = embeddedOrgId;
                request.employeeId = embeddedEmployeeId;
            } else {
                // Steps 3 & 3b: Resolve organization + employee identity.
                // Results are cached in Redis (5 min TTL) so high-frequency polling
                // (e.g. 50 VUs on the admin dashboard) doesn't hit the users/employees
                // tables on every request — a single DB round-trip per cache window.
                interface UserAuthContext { organizationId: string; employeeId: string | undefined; }
                const authContext = await getCached<UserAuthContext>(
                    `auth:user:${userId}`,
                    300, // 5-minute TTL
                    async () => {
                        // Run both queries in parallel — users.id is globally unique
                        // so we don't need organization_id from users to scope the
                        // employees query.  We validate org consistency afterwards.
                        const [userResult, employeeResult] = await Promise.all([
                            supabaseServiceClient
                                .from("users")
                                .select("organization_id")
                                .eq("id", userId)
                                .single(),
                            supabaseServiceClient
                                .from("employees")
                                .select("id, organization_id")
                                .eq("user_id", userId)
                                .eq("is_active", true)
                                .limit(1)
                                .maybeSingle(),
                        ]);

                        if (userResult.error || !userResult.data) {
                            request.log.warn({ sub: userId, error: userResult.error }, "User not found in database");
                            throw new UnauthorizedError("User not found");
                        }

                        const orgId = userResult.data.organization_id;

                        // Only accept the employee row if it belongs to the same org
                        // (defence-in-depth: a user_id should never straddle two orgs).
                        const empRow = employeeResult.data;
                        const employeeId =
                            empRow && empRow.organization_id === orgId
                                ? (empRow.id as string)
                                : undefined;

                        return { organizationId: orgId, employeeId };
                    },
                );

                organizationId = authContext.organizationId;
                request.employeeId = authContext.employeeId;
            }
        }

        // Step 4: Validate complete user context with Zod
        const result = jwtPayloadSchema.safeParse({
            sub: userId,
            email: email,
            role: role,
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

        // Step 5: Attach authenticated user to request
        request.user = result.data;
        request.organizationId = result.data.organization_id;

        // Attach the user's identity to the active trace span so every
        // downstream span in this request is automatically tagged with the
        // actor. Invaluable for debugging permission or data-isolation issues.
        const span = trace.getSpan(context.active());
        if (span) {
            span.setAttribute("enduser.id", result.data.sub);
            span.setAttribute("enduser.role", result.data.role);
        }
    } catch (error) {
        // Never log the raw token for security reasons
        const err = error instanceof UnauthorizedError
            ? error
            : new UnauthorizedError("Invalid or missing authentication token");

        // `return` after send is required in Fastify async preValidation hooks.
        // Without it, the hook resolves normally and Fastify proceeds to call the
        // route handler — which then hits "Reply already sent". The client still
        // receives 401, but Fastify logs a spurious internal error.
        void reply.status(err.statusCode).send(fail(err.message, request.id));
        return;
    }
}
