import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { trace, context } from "@opentelemetry/api";
import fp from "fastify-plugin";
import { env } from "./config/env.js";
import { getLoggerConfig } from "./config/logger.js";
import { registerRoutes } from "./routes/index.js";
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
// @fastify/compress intentionally removed: on Node.js >= 22.15, the
// peek-stream dependency (fastify-compress-#355) causes silent onSend
// hook failures that return an empty body with status 200.
// Response compression is handled instead at the Nginx/Cloudflare layer.

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: getLoggerConfig(env.APP_ENV),
    trustProxy: true,
    // Phase 10: HTTP hardening (externalized limits)
    bodyLimit: env.BODY_LIMIT_BYTES,
    connectionTimeout: env.REQUEST_TIMEOUT_MS,
    keepAliveTimeout: 72_000,        // 72 s keep-alive (ALB default is 60 s)
    // Phase 10: Request correlation — generate UUID if no x-request-id header provided
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  });

  // ─── Phase 15: Security Plugin Stack ────────────────────────────────────────
  // Registered in order: helmet → cors → rate-limit → abuse-logging.
  // Each plugin is isolated in src/plugins/security/ for maintainability.

  // Log startup configuration for instant debugging
  app.log.info({
    apiBaseUrl: env.API_BASE_URL ?? "(unset)",
    apiHostname: env.API_BASE_URL ? new URL(env.API_BASE_URL).host : undefined,
    workersEnabled: env.WORKERS_ENABLED,
  }, "startup:config");

  // Register Zod validator/serializer compilers before any routes or plugins
  // that might add routes. This is the single place that enables Zod schema
  // support — openapi.plugin.ts no longer duplicates this registration.
  registerZod(app);

  await app.register(helmetPlugin);
  await app.register(corsPlugin);
  await app.register(rateLimitPlugin);
  await app.register(abuseLoggingPlugin);

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

  // Phase 10: x-request-id header and span stamping.
  await app.register(fp(async function onSendSafetyPlugin(instance: FastifyInstance) {
    instance.addHook("onSend", async (request, reply, payload) => {
      void reply.header("x-request-id", request.id);
      const span = trace.getSpan(context.active());
      if (span) {
        span.setAttribute("http.status_code", reply.statusCode);
      }

      return payload;
    });
  }, { name: "onSend-safety", fastify: "5.x" }));

  // Performance timing — logs every response with full correlation context:
  // requestId, method, route, status, elapsed ms, userId, organizationId.
  // Emits WARN for responses slower than 500 ms so slow endpoints are
  // immediately visible in Grafana/Loki without a query.
  // Emits ERROR for responses slower than 2000 ms — indicates a serious problem.
  app.addHook("onResponse", async (request, reply) => {
    const ms = Math.round(reply.elapsedTime);
    const logPayload = {
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url ?? request.url,
      status: reply.statusCode,
      responseTimeMs: ms,
      // Populated only for authenticated routes — undefined otherwise
      userId: (request as { user?: { sub?: string } }).user?.sub,
      organizationId: (request as { organizationId?: string }).organizationId,
    };
    if (ms > 2_000) {
      request.log.error({ ...logPayload, slow_request: true }, "very_slow_response");
    } else if (ms > 500) {
      request.log.warn({ ...logPayload, slow_request: true }, "slow_response");
    } else {
      request.log.info(logPayload, "response");
    }
  });

  // Phase 10: Global error handler — unhandled errors include requestId
  app.setErrorHandler<Error>((error, request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({
        success: false,
        error: error.message,
        requestId: request.id,
        code: error.code,
        details: error.details,
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
    // Track error rate — emit structured log field so Loki/Grafana can count 5xx per route
    request.log.error(
      {
        error_rate_event: true,
        route: request.routeOptions?.url ?? request.url,
        method: request.method,
        requestId: request.id,
      },
      "error_rate_event",
    );
    void reply.status(500).send({
      success: false,
      error: "Internal server error",
      requestId: request.id,
    });
  });

  // ─── Existing Plugins ───────────────────────────────────────────────────────

  // Prometheus metrics — GET /metrics (token-protected in production)
  await app.register(prometheusPlugin);

  // Phase 19: OpenAPI documentation plugin — must be registered before routes
  // so that route schemas are properly captured in the OpenAPI specification
  await app.register(openApiPlugin);

  // Register routes
  await registerRoutes(app);

  // NOTE: Workers and startup recovery are intentionally started in server.ts
  // after app.listen() resolves. This keeps lifecycle explicit and prevents
  // accidental starts during app construction or module import.

  return app;
}
