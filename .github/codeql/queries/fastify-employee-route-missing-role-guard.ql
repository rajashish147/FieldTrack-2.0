/**
 * @name Fastify EMPLOYEE-only route missing role guard
 * @description A Fastify route that creates or accesses employee-scoped
 *              resources (attendance, expenses) uses only authenticate in
 *              preValidation but no requireRole("EMPLOYEE") guard.
 *              ADMIN users can call these routes; the only protection is
 *              a service-layer check, which violates defense-in-depth.
 * @kind problem
 * @problem.severity warning
 * @id fieldtrack/fastify-employee-route-missing-role-guard
 * @tags security
 *       authentication
 *       fastify
 * @precision medium
 */
import javascript

// ─── Helpers ────────────────────────────────────────────────────────────────

predicate arrayContainsRequireRole(Expr arrayExpr) {
  exists(CallExpr requireRoleCall |
    requireRoleCall.getCallee().(Identifier).getName() = "requireRole" and
    requireRoleCall = arrayExpr.(ArrayExpr).getAnElement()
  )
}

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
  routeReg.getMethodName() in ["get", "post", "put", "patch", "delete"] and
  path = routeReg.getArgument(0) and
  options = routeReg.getArgument(1) and

  // Employee-scoped resource paths (not admin, not health, not internal)
  (
    path.getStringValue().matches("%/attendance/%") or
    path.getStringValue().matches("%/expenses%") or
    path.getStringValue().matches("%/locations/%")
  ) and
  not path.getStringValue().matches("%/admin/%") and

  // Has authenticate but no requireRole
  exists(Property preValidation, ArrayExpr arr |
    preValidation.getParent() = options and
    preValidation.getName() = "preValidation" and
    arr = preValidation.getInit() and
    exists(Expr elem |
      elem = arr.getAnElement() and
      elem.(Identifier).getName() = "authenticate"
    )
  ) and

  not optionsHaveRoleGuard(options)

select routeReg,
  "Route '" + path.getStringValue() +
  "' operates on employee-scoped data but has no requireRole() guard. " +
  "Consider adding requireRole(\"EMPLOYEE\") for defense-in-depth."
