import type { FastifyInstance } from "fastify";
import { distanceQueue } from "../workers/distance.queue.js";
import { authenticate } from "../middleware/auth.js";
import { env } from "../config/env.js";

interface DebugRedisResponse {
  status: "ok" | "error";
  redis: string;
}

interface ClaimPresence {
  present: boolean;
  value: unknown;
}

interface DebugAuthResponse {
  sub: unknown;
  email: unknown;
  role: unknown;
  org_id: unknown;
  employee_id: unknown;
  source: "top-level" | "app_metadata" | "missing";
  claims: {
    role: ClaimPresence;
    org_id: ClaimPresence;
    employee_id: ClaimPresence;
  };
  hook_ok: boolean;
  raw: Record<string, unknown>;
}

/**
 * Debug routes for observability validation.
 *
 * GET /debug/redis     — pings Redis via the BullMQ ioredis connection.
 * GET /auth/debug      — decodes the bearer JWT and reports which hook-injected
 *                        claims are present. Requires a valid JWT. Useful for
 *                        verifying that custom_access_token_hook is active.
 *
 * Both endpoints are disabled in production to prevent infrastructure
 * information disclosure.
 */
export async function debugRoutes(app: FastifyInstance): Promise<void> {
  // Only register debug routes in non-production environments
  if (env.APP_ENV === "production") {
    app.log.info("Debug routes disabled in production");
    return;
  }

  app.get<{ Reply: DebugRedisResponse }>(
    "/debug/redis",
    async (request, reply): Promise<void> => {
      try {
        // Reuse the ioredis connection that BullMQ already owns.
        // waitUntilReady() resolves to the same RedisClient instance used by
        // the queue — no new TCP connection is opened.
        const redisClient = await distanceQueue.waitUntilReady();
        const pong = await redisClient.ping();

        request.log.info({ redis: pong }, "debug/redis ping succeeded");
        void reply.status(200).send({ status: "ok", redis: pong });
      } catch (error) {
        request.log.error({ err: error }, "debug/redis ping failed");
        void reply.status(503).send({ status: "error", redis: "unreachable" });
      }
    },
  );

  /**
   * GET /auth/debug
   *
   * Returns the decoded JWT claims so developers can verify that
   * custom_access_token_hook is correctly injecting role, org_id, and
   * employee_id.  Authentication is required — the bearer token is the
   * one being inspected.
   *
   * Claims check:
   *   role        should be "ADMIN" or "EMPLOYEE" (not "authenticated")
   *   org_id      should be a UUID string
   *   employee_id should be a UUID string (EMPLOYEE role only)
   */
  app.get<{ Reply: DebugAuthResponse }>(
    "/auth/debug",
    { preHandler: [authenticate] },
    async (request, reply): Promise<void> => {
      const authHeader = request.headers.authorization ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : "";

      let raw: Record<string, unknown> = {};

      if (token) {
        try {
          const parts = token.split(".");
          const payload = parts[1] ?? "";
          // Restore standard base64 from base64url and add padding
          const padded = payload.replace(/-/g, "+").replace(/_/g, "/") +
            "=".repeat((4 - (payload.length % 4)) % 4);
          raw = JSON.parse(Buffer.from(padded, "base64").toString("utf-8")) as Record<string, unknown>;
        } catch {
          // Decoding failed; auth middleware already verified the signature so
          // this path should never be reached in practice.
        }
      }

      // Determine which claim format was injected by the hook.
      // New hook (Phase 28a): writes role/org_id/employee_id at top level.
      // Old hook (Phase 5):   writes to app_metadata.role / app_metadata.organization_id.
      const appMeta = raw.app_metadata as Record<string, unknown> | undefined;
      const topLevelRole = raw.role as string | undefined;
      const appMetaRole  = appMeta?.role as string | undefined;

      const resolvedRole       = topLevelRole ?? appMetaRole;
      const resolvedOrgId      = (raw.org_id as string | undefined) ?? (appMeta?.organization_id as string | undefined);
      const resolvedEmployeeId = (raw.employee_id as string | undefined) ?? (appMeta?.employee_id as string | undefined);

      const source: "top-level" | "app_metadata" | "missing" =
        topLevelRole ? "top-level" :
        appMetaRole  ? "app_metadata" :
        "missing";

      void reply.status(200).send({
        sub:         raw.sub,
        email:       raw.email,
        role:        resolvedRole,
        org_id:      resolvedOrgId,
        employee_id: resolvedEmployeeId,
        source,
        hook_ok: source !== "missing" && !!resolvedOrgId,
        claims: {
          role:        { present: !!resolvedRole,       value: resolvedRole },
          org_id:      { present: !!resolvedOrgId,      value: resolvedOrgId },
          employee_id: { present: !!resolvedEmployeeId, value: resolvedEmployeeId },
        },
        raw,
      });
    },
  );
}

