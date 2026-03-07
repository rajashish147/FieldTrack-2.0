import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { trace, context } from "@opentelemetry/api";
import { env } from "./config/env.js";
import { getLoggerConfig } from "./config/logger.js";
import { registerJwt } from "./plugins/jwt.js";
import { registerRoutes } from "./routes/index.js";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyHelmet from "@fastify/helmet";
import fastifyCompress from "@fastify/compress";
import fastifyCors from "@fastify/cors";
import { startDistanceWorker } from "./workers/distance.worker.js";
import { AppError } from "./utils/errors.js";
import prometheusPlugin from "./plugins/prometheus.js";

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

  // ─── Phase 10: Security & Performance Plugins ───────────────────────────────

  // Helmet sets secure HTTP headers (CSP, HSTS, X-Frame-Options, etc.)
  await app.register(fastifyHelmet);

  // Gzip/deflate/brotli response compression
  await app.register(fastifyCompress);

  // CORS — restrict to origins listed in ALLOWED_ORIGINS env var
  await app.register(fastifyCors, {
    origin: env.ALLOWED_ORIGINS.length > 0 ? env.ALLOWED_ORIGINS : false,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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
  app.addHook("onSend", async (request, reply) => {
    void reply.header("x-request-id", request.id);
    const span = trace.getSpan(context.active());
    if (span) {
      span.setAttribute("http.status_code", reply.statusCode);
    }
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

    request.log.error({ error: error.message, requestId: request.id }, "Unhandled error");
    void reply.status(500).send({
      success: false,
      error: "Internal server error",
      requestId: request.id,
    });
  });

  // ─── Existing Plugins ───────────────────────────────────────────────────────

  await app.register(fastifyRateLimit, {
    global: false, // Applied selectively per-route
  });

  // Prometheus metrics — unauthenticated GET /metrics (scrape endpoint)
  await app.register(prometheusPlugin);

  await registerJwt(app);

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
