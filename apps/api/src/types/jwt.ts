import { z } from "zod";

/**
 * The two roles that exist in the database `user_role` enum.
 *
 * Keeping this list in sync with the Postgres enum is intentional:
 *   CREATE TYPE public.user_role AS ENUM ('ADMIN', 'EMPLOYEE');
 *
 * Previous versions included SUPERVISOR, FINANCE, and TEAM_LEAD here.
 * Those roles do NOT exist in the database and can never be assigned via
 * the normal signup/auth flow.  Accepting them in the JWT schema was a
 * security gap: a crafted token claiming role:"SUPERVISOR" would pass
 * authenticate() even though no DB record could legitimately carry that role.
 *
 * If new roles are added to the DB enum in the future, add them here at
 * the same time and update requireRole() call-sites accordingly.
 */
const ROLES = ["ADMIN", "EMPLOYEE"] as const;

export type UserRole = (typeof ROLES)[number];

/**
 * Strict schema for validating decoded JWT payloads.
 * Every request must carry a valid sub, role (from user_metadata), and organization_id.
 *
 * Phase 20: role is extracted from user_metadata.role (not the top-level role
 * claim, which is always "authenticated" for Supabase user tokens).
 */
export const jwtPayloadSchema = z.object({
    sub: z.string().min(1, "JWT 'sub' claim is required"),
    email: z.string().email().optional(),
    role: z.enum(ROLES, {
        error: "Role must be ADMIN or EMPLOYEE",
    }),
    organization_id: z.string().uuid({ error: "organization_id must be a valid UUID" }),
});

export type JwtPayload = z.infer<typeof jwtPayloadSchema>;
