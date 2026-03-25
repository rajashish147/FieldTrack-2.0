/**
 * @name Supabase query missing organization_id tenant filter
 * @description A direct Supabase .from() call is not wrapped by tenantQuery()
 *              or enforceTenant(), and does not have a chained
 *              .eq("organization_id", …) call. This can cause cross-tenant
 *              data exposure in the multi-tenant SaaS model where
 *              supabaseServiceClient bypasses RLS.
 * @kind problem
 * @problem.severity error
 * @id fieldtrack/supabase-missing-tenant-filter
 * @tags security
 *       multi-tenant
 *       supabase
 * @precision medium
 */
import javascript

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * A call to supabase.from("table_name") using the service-role client.
 * Matches both variable names used in the codebase:
 *   supabaseServiceClient.from(…)
 *   supabase.from(…)       (local alias)
 */
class SupabaseFromCall extends MethodCallExpr {
  SupabaseFromCall() {
    this.getMethodName() = "from" and
    (
      this.getReceiver().(VarAccess).getName().regexpMatch("supabase.*") or
      this.getReceiver().(Identifier).getName().regexpMatch("supabase.*")
    )
  }

  string getTableName() {
    result = this.getArgument(0).(StringLiteral).getStringValue()
  }
}

/**
 * Tables that are INTENTIONALLY global (no org scope):
 *   organizations — org lookup by id, never multi-tenant filtered
 *   users / auth  — Supabase-managed
 *   queue_retry_intents — internal ops table (see issue C1 for the fix)
 *
 * Add known-safe tables here to reduce false positives.
 */
predicate isGlobalTable(string tableName) {
  tableName in [
    "organizations",
    "storage.objects"
  ]
}

/**
 * Returns true if an .eq("organization_id", …) call is chained anywhere
 * in the method call chain rooted at `base`.
 */
predicate hasOrganizationIdEq(MethodCallExpr base) {
  exists(MethodCallExpr eqCall |
    eqCall.getMethodName() = "eq" and
    eqCall.getArgument(0).(StringLiteral).getStringValue() = "organization_id" and
    (
      // Direct chain: base.select(...).eq("organization_id", ...)
      eqCall.getReceiver+() = base or
      // Reverse: the from() call is the receiver chain leading to eqCall
      base.getReceiver+() = eqCall
    )
  )
}

/**
 * Returns true if the from() call is passed as an argument to tenantQuery(),
 * enforceTenant(), or orgTable() — the approved isolation wrappers.
 *
 * orgTable() is the preferred wrapper in repository files: it constructs the
 * Supabase query and applies .eq("organization_id", ...) at construction time,
 * so the from() call never appears with a chained .eq() — the ql predicate must
 * treat orgTable() calls as implicitly tenant-scoped.
 *
 * Note: INSERT/UPSERT operations legitimately call supabase.from() directly
 * and set organization_id in the body payload, not as a .eq() filter.
 * Those are flagged by hasOrganizationIdInPayload() below and suppressed.
 */
predicate isWrappedInTenantHelper(SupabaseFromCall fromCall) {
  // Pattern 1: tenantQuery(request, supabase.from("x"))
  exists(CallExpr wrapper |
    wrapper.getCallee().(Identifier).getName() in ["tenantQuery", "enforceTenant"] and
    wrapper.getAnArgument() = fromCall
  )
  or
  // Pattern 2: tenantQuery(request, supabase.from("x").select("*"))
  exists(CallExpr wrapper, MethodCallExpr chain |
    wrapper.getCallee().(Identifier).getName() in ["tenantQuery", "enforceTenant"] and
    chain.getReceiver+() = fromCall and
    wrapper.getAnArgument() = chain
  )
  or
  // Pattern 3: orgTable(request, "table_name")
  // This wrapper does NOT call supabase.from() inline — it is a factory that
  // internally calls supabase.from() + .eq("organization_id", ...).
  // From the call-site perspective the findable pattern is:
  //   orgTable(request, "employees").select("*")
  // The supabase.from() call inside orgTable's implementation IS flagged but
  // it belongs to a trusted utility — suppress it by file path.
  fromCall.getFile().getAbsolutePath().matches("%db/query%")
}

/**
 * Suppress findings in files that are intentionally cross-tenant:
 *   workers/   — BullMQ workers receive job payloads with pre-validated session IDs.
 *                They operate globally to process jobs from any org. Tenant scoping
 *                happens at the job-enqueue boundary, not inside the worker.
 *   scripts/   — One-off backfill/migration scripts that purposefully touch all orgs.
 *   plugins/prometheus.ts — Global metric aggregation (no per-org scope by design).
 */
predicate isIntentionallyGlobalContext(SupabaseFromCall fromCall) {
  fromCall.getFile().getAbsolutePath().matches("%/workers/%") or
  fromCall.getFile().getAbsolutePath().matches("%\\workers\\%") or
  fromCall.getFile().getAbsolutePath().matches("%/scripts/%") or
  fromCall.getFile().getAbsolutePath().matches("%\\scripts\\%") or
  fromCall.getFile().getAbsolutePath().matches("%prometheus%")
}

// ─── Query ───────────────────────────────────────────────────────────────────

/**
 * Returns true when the Supabase call chain contains an INSERT/UPSERT (.insert
 * or .upsert) where the payload object has an "organization_id" property.
 * These are secure by construction and should not be flagged.
 */
predicate isInsertWithOrgId(SupabaseFromCall fromCall) {
  exists(MethodCallExpr mutationCall, ObjectExpr payload, Property orgProp |
    mutationCall.getMethodName() in ["insert", "upsert"] and
    mutationCall.getReceiver+() = fromCall and
    // First argument to insert/upsert is the payload object
    payload = mutationCall.getArgument(0) and
    orgProp.getParent() = payload and
    orgProp.getName() = "organization_id"
  )
}

from SupabaseFromCall fromCall
where
  not isGlobalTable(fromCall.getTableName()) and
  not isWrappedInTenantHelper(fromCall) and
  not hasOrganizationIdEq(fromCall) and
  not isInsertWithOrgId(fromCall) and
  not isIntentionallyGlobalContext(fromCall)

select fromCall,
  "Supabase query on '" + fromCall.getTableName() +
  "' uses the service-role client and is not scoped by organization_id. " +
  "Wrap with tenantQuery() or add .eq(\"organization_id\", …)."
