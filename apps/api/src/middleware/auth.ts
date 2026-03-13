import type { FastifyRequest, FastifyReply } from "fastify";
import { trace, context } from "@opentelemetry/api";
import { validate as uuidValidate } from "uuid";
import { jwtPayloadSchema } from "../types/jwt.js";
import { UnauthorizedError } from "../utils/errors.js";
import { fail } from "../utils/response.js";
import { verifySupabaseToken } from "../auth/jwtVerifier.js";
import { supabaseServiceClient } from "../config/supabase.js";
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
        // In test mode (NODE_ENV=test), use @fastify/jwt for backward compatibility
        // In production, use Supabase JWKS verification
        if (env.NODE_ENV === "test") {
            // Test mode: use @fastify/jwt (synchronous verification)
            try {
                const decoded = request.server.jwt.verify(token) as any;
                userId = decoded.sub;
                role = decoded.role; // Test tokens have role at top level
                email = decoded.email;
                organizationId = decoded.organization_id;
                // Test tokens embed employee_id directly to avoid a DB call in tests.
                // signEmployeeToken includes it; ADMIN tokens omit it → undefined.
                // Use process.env directly (not the validated env object) so this
                // shortcut is provably unreachable outside a test process.
                if (process.env.NODE_ENV === "test") {
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

            // Step 3: Load user data from database
            // Fetch organization_id since it's not in the JWT payload
            const { data: userData, error: userError } = await supabaseServiceClient
                .from("users")
                .select("organization_id")
                .eq("id", decoded.sub)
                .single();

            if (userError || !userData) {
                request.log.warn({ sub: decoded.sub, error: userError }, "User not found in database");
                throw new UnauthorizedError("User not found");
            }

            organizationId = userData.organization_id;

            // Step 3b: Resolve employees.id for this user (once, upfront).
            // EMPLOYEE routes need employees.id (employees.id ≠ users.id).
            // ADMIN users may not have an employees row — undefined is expected.
            const { data: employeeData } = await supabaseServiceClient
                .from("employees")
                .select("id")
                .eq("user_id", decoded.sub)
                .eq("organization_id", organizationId)
                .eq("is_active", true)
                .limit(1)
                .maybeSingle();

            request.employeeId = employeeData?.id ?? undefined;
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
