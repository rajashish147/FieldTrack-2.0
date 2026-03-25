/**
 * @name Fastify route missing requireRole guard
 * @description A Fastify route under /admin/ or with destructive methods has
 *              authenticate in preValidation but no requireRole() call.
 *              Any authenticated user with any role can invoke it.
 * @kind problem
 * @problem.severity error
 * @id fieldtrack/fastify-missing-role-guard
 * @tags security
 *       authentication
 *       fastify
 * @precision high
 */
import javascript

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns true if the given expression is (or evaluates to) an array literal
 * that contains a call to requireRole(…).
 */
predicate arrayContainsRequireRole(Expr arrayExpr) {
  exists(CallExpr requireRoleCall |
    requireRoleCall.getCallee().(Identifier).getName() = "requireRole" and
    requireRoleCall = arrayExpr.(ArrayExpr).getAnElement()
  )
}

/**
 * Returns true if the options object passed to the route registration
 * contains a preValidation array that calls requireRole(…).
 */
predicate optionsHaveRoleGuard(ObjectExpr options) {
  exists(Property preValidation |
    preValidation.getParent() = options and
    preValidation.getName() = "preValidation" and
    arrayContainsRequireRole(preValidation.getInit())
  )
}

// ─── Query ───────────────────────────────────────────────────────────────────

from MethodCallExpr routeReg, StringLiteral path, ObjectExpr options
where
  // Match Fastify route helper calls: app.get / app.post / app.patch etc.
  routeReg.getMethodName() in ["get", "post", "put", "patch", "delete"] and
  path = routeReg.getArgument(0) and
  options = routeReg.getArgument(1) and

  // Only flag /admin/ paths — these definitely require ADMIN role
  path.getStringValue().matches("%/admin/%") and

  // The route DOES include authenticate (so it is not a public route)
  exists(Property preValidation, ArrayExpr arr |
    preValidation.getParent() = options and
    preValidation.getName() = "preValidation" and
    arr = preValidation.getInit() and
    exists(Expr elem |
      elem = arr.getAnElement() and
      elem.(Identifier).getName() = "authenticate"
    )
  ) and

  // But does NOT include requireRole(…)
  not optionsHaveRoleGuard(options)

select routeReg,
  "Admin route '" + path.getStringValue() +
  "' has authenticate but no requireRole() in preValidation. " +
  "Any authenticated user — regardless of role — can call it."
