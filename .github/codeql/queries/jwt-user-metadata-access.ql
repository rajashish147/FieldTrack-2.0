/**
 * @name JWT user_metadata accessed for authorization
 * @description user_metadata in a Supabase JWT is controlled by the end user.
 *              Using it for authorization decisions (role, org_id, employee_id)
 *              is a security vulnerability — attackers can forge these values.
 *              Auth claims must come from app_metadata (server-controlled) or
 *              top-level claims injected by the custom_access_token_hook.
 * @kind problem
 * @problem.severity error
 * @id fieldtrack/jwt-user-metadata-trust
 * @tags security
 *       jwt
 *       authentication
 * @precision high
 */
import javascript

// ─── Query ───────────────────────────────────────────────────────────────────

/*
 * Matches any property access of the form:
 *   decoded.user_metadata.<anything>
 *   payload.user_metadata.role
 *   token.user_metadata.org_id
 * …where the outer access reads an authorization-sensitive field.
 */
from PropAccess userMetaAccess, PropAccess outerAccess, string authField
where
  // The inner access is .user_metadata on any identifier
  userMetaAccess.getPropertyName() = "user_metadata" and

  // The outer access reads a security-sensitive field from user_metadata
  outerAccess.getBase() = userMetaAccess and
  authField = outerAccess.getPropertyName() and
  authField in ["role", "org_id", "organization_id", "employee_id", "is_admin", "permissions"]

select outerAccess,
  "Authorization field '" + authField + "' is read from user_metadata, " +
  "which is user-controlled. Use app_metadata." + authField +
  " or the top-level JWT claim injected by the Supabase auth hook instead."
