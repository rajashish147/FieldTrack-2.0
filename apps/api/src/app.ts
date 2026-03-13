import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { trace, context } from "@opentelemetry/api";
import { env } from "./config/env.js";
import { getLoggerConfig } from "./config/logger.js";
import { registerJwt } from "./plugins/jwt.js";
import { registerRoutes } from "./routes/index.js";
import fastifyCompress from "@fastify/compress";
import { startDistanceWorker } from "./workers/distance.worker.js";
import { AppError } from "./utils/errors.js";
import prometheusPlugin from "./plugins/prometheus.js";
// Phase 15: Dedicated security plugins
import helmetPlugin from "./plugins/security/helmet.plugin.js";
import corsPlugin from "./plugins/security/cors.plugin.js";
import rateLimitPlugin from "./plugins/security/ratelimit.plugin.js";
import abuseLoggingPlugin from "./plugins/security/abuse-logging.plugin.js";
// Phase 19: OpenAPI documentation
import openApiPlugin from "./plugins/openapi.plugin.js";
import { registerZod } from "./plugins/zod.plugin.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: getLoggerConfig(env.NODE_ENV),
    // Phase 10: HTTP hardening
    bodyLimit: 1_000_000,           // 1 MB max request body
    connectionTimeout: 5_000,        // 5 s TCP connection timeout
    keepAliveTimeout: 72_000,        // 72 s keep-alive (ALB default is 60 s)
    // Phase 10: Request correlation — generate UUID if no x-request-id header provided
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  });

  // ─── Phase 15: Security Plugin Stack ────────────────────────────────────────
  // Registered in order: helmet → cors → rate-limit → abuse-logging.
  // Each plugin is isolated in src/plugins/security/ for maintainability.

  // Register Zod validator/serializer compilers before any routes or plugins
  // that might add routes. This is the single place that enables Zod schema
  // support — openapi.plugin.ts no longer duplicates this registration.
  registerZod(app);

  await app.register(helmetPlugin);
  await app.register(corsPlugin);
  await app.register(rateLimitPlugin);
  await app.register(abuseLoggingPlugin);

  // Gzip + brotli response compression.
  // zstd is intentionally excluded: Swagger UI cannot decode it and sends an
  // empty body. Modern browsers advertise zstd in Accept-Encoding, which
  // @fastify/compress would otherwise prefer over gzip/br.
  // threshold: skip compression for responses under 1 KB.
  await app.register(fastifyCompress, {
    encodings: ["gzip", "br"],
    global: true,
    threshold: 1024,
  });

  // Enrich the active HTTP span with Fastify-level context that the HTTP
  // auto-instrumentation cannot see: the matched route pattern, the Fastify
  // request ID, and the direct client IP.
  //
  // http.route uses the pattern (e.g. /users/:id) rather than the raw URL so
  // that Grafana's service graph groups requests by route, not by value.
  app.addHook("onRequest", async (request) => {
    const span = trace.getSpan(context.active());
    if (span) {
      const spanContext = span.spanContext();

      // Enrich logger with trace context for correlation in Grafana
      request.log = request.log.child({
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
      });

      if (request.routeOptions.url) {
        span.setAttribute("http.route", request.routeOptions.url);
      }
      span.setAttribute("http.method", request.method);
      span.setAttribute("http.client_ip", request.ip);
      span.setAttribute("request.id", String(request.id));
      if (request.hostname) {
        span.setAttribute("server.address", request.hostname);
      }
    }
  });

  // Phase 10: Add x-request-id to every reply for end-to-end tracing.
  // Also stamp the final status code on the span; the span is still open
  // during onSend (it closes after the socket write completes).
  // SAFETY: Ensure response payload is never undefined/null for JSON endpoints
  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-request-id", request.id);
    const span = trace.getSpan(context.active());
    if (span) {
      span.setAttribute("http.status_code", reply.statusCode);
    }

    // Safety check: prevent empty responses for JSON endpoints
    // Returns a valid response matching the standard { success, data } contract
    const contentType = reply.getHeader("content-type");
    if (
      contentType &&
      typeof contentType === "string" &&
      contentType.includes("application/json") &&
      reply.statusCode >= 200 &&
      reply.statusCode < 300 &&
      (payload === undefined || payload === null || payload === "")
    ) {
      request.log.warn(
        {
          url: request.url,
          method: request.method,
          statusCode: reply.statusCode,
        },
        "Empty JSON response detected - returning standard empty response",
      );
      return JSON.stringify({
        success: true,
        data: [],
      });
    }

    return payload;
  });

  // Phase 10: Global error handler — unhandled errors include requestId
  app.setErrorHandler<Error>((error, request, reply) => {
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

    request.log.error({ error: error.message, requestId: request.id }, "Unhandled error");
    void reply.status(500).send({
      success: false,
      error: "Internal server error",
      requestId: request.id,
    });
  });

  // ─── Existing Plugins ───────────────────────────────────────────────────────

  // Prometheus metrics — GET /metrics (token-protected in production)
  await app.register(prometheusPlugin);

  // @fastify/jwt is only needed in test mode (HS256 test tokens).
  // Production uses JWKS/ES256 verification in auth.ts via verifySupabaseToken().
  if (env.NODE_ENV === "test") {
    await registerJwt(app);
  }

  // Phase 19: OpenAPI documentation plugin — must be registered before routes
  // so that route schemas are properly captured in the OpenAPI specification
  await app.register(openApiPlugin);

  // Register routes
  await registerRoutes(app);

  // Phase 10: Start BullMQ distance worker on boot.
  // The worker runs its own Redis-backed event loop — no blocking here.
  startDistanceWorker(app);

  // NOTE: performStartupRecovery is intentionally NOT called here.
  // It must run AFTER app.listen() resolves in server.ts so it never
  // prevents the server from accepting traffic during the recovery scan.

  return app;
}
