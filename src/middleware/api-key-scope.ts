import type { ApiKeyScope } from "../modules/api-keys/api-keys.schema.js";
import { ForbiddenError } from "../utils/errors.js";

function routeScope(method: string, routePath: string): ApiKeyScope | "admin:all" | null {
  // null = any authenticated API key may call this endpoint (no additional scope needed)
  if (routePath === "/auth/me") return null;

  if (method === "GET" && routePath.startsWith("/admin/employees")) return "read:employees";
  if (method === "GET" && (routePath.startsWith("/admin/sessions") || routePath === "/attendance/my-sessions")) {
    return "read:sessions";
  }
  if (
    (method === "POST" && routePath === "/expenses") ||
    (method === "GET" && routePath === "/expenses/my") ||
    (method === "PATCH" && routePath.startsWith("/admin/expenses/"))
  ) {
    return "write:expenses";
  }
  return "admin:all";
}

export function hasApiKeyScope(scopes: ApiKeyScope[], required: ApiKeyScope | "admin:all"): boolean {
  if (scopes.includes("admin:all")) return true;
  return scopes.includes(required as ApiKeyScope);
}

export function enforceApiKeyScope(method: string, routePath: string, scopes: ApiKeyScope[]): void {
  const required = routeScope(method.toUpperCase(), routePath);
  if (required === null) return; // endpoint accessible to any authenticated API key
  if (!hasApiKeyScope(scopes, required)) {
    throw new ForbiddenError(`API key missing required scope: ${required}`);
  }
}
