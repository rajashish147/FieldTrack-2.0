/**
 * test-server.ts — lightweight Fastify instance for integration tests.
 *
 * Registers:
 *  - @fastify/jwt (using the test secret from env)
 *  - global error handler (mirrors app.ts)
 *  - all application routes
 *
 * Intentionally skips: helmet, CORS, rate-limiting, BullMQ workers,
 * and Prometheus registration so tests are fast and externally isolated.
 *
 * Module mocks (vi.mock) in each test file replace repository/queue
 * imports before this module is loaded, so the mocks are active when
 * registerRoutes() triggers the full import chain.
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyJwt from "@fastify/jwt";
import { registerZod } from "../../src/plugins/zod.plugin.js";
import { registerRoutes } from "../../src/routes/index.js";
import { AppError } from "../../src/utils/errors.js";

// ─── Shared test identity constants ──────────────────────────────────────────

// UUIDs must satisfy Zod v4's stricter RFC-4122 regex:
// 3rd group starts with [1-8] (version), 4th group starts with [89abAB] (variant).
export const TEST_ORG_ID = "11111111-1111-4111-8111-111111111111";
/** A second organisation used in cross-tenant isolation tests. */
export const TEST_ORG_ID_B = "22222222-2222-4222-8222-222222222222";
export const TEST_EMPLOYEE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const TEST_ADMIN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const TEST_SESSION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// ─── App factory ─────────────────────────────────────────────────────────────

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Zod type provider — must be set before route registration so Fastify
  // can compile Zod schemas placed in route schema.querystring / schema.body.
  registerZod(app);

  // JWT — must match the secret used when signing test tokens
  await app.register(fastifyJwt, {
    secret: process.env["SUPABASE_JWT_SECRET"] ?? "test-secret",
  });

  // Mirror the production error handler from app.ts so integration tests
  // see the same { success, error, requestId } shape on errors.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({
        success: false,
        error: error.message,
        requestId: request.id,
      });
      return;
    }
    // Pass through Fastify built-in errors (validation, rate-limit, etc.) that
    // carry their own HTTP status code so clients receive 400/422/429 instead
    // of a generic 500.
    const builtinStatus = (error as { statusCode?: number }).statusCode;
    if (builtinStatus !== undefined && builtinStatus >= 400 && builtinStatus < 500) {
      void reply.status(builtinStatus).send({
        success: false,
        error: error.message,
        requestId: request.id,
      });
      return;
    }
    void reply.status(500).send({
      success: false,
      error: "Internal server error",
      requestId: request.id,
    });
  });

  await registerRoutes(app);
  await app.ready();
  return app;
}

// ─── Token helpers ────────────────────────────────────────────────────────────

export function signEmployeeToken(
  app: FastifyInstance,
  userId = TEST_EMPLOYEE_ID,
  orgId = TEST_ORG_ID,
): string {
  // Embed employee_id so auth middleware can set request.employeeId without a DB call.
  // In tests, employee_id == userId for simplicity (same UUID, no actual DB mapping).
  return app.jwt.sign({ sub: userId, role: "EMPLOYEE", org_id: orgId, employee_id: userId });
}

export function signAdminToken(
  app: FastifyInstance,
  userId = TEST_ADMIN_ID,
  orgId = TEST_ORG_ID,
): string {
  return app.jwt.sign({ sub: userId, role: "ADMIN", org_id: orgId });
}
