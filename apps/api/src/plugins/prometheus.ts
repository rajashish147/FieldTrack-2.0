import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import client from "prom-client";
import { trace, context } from "@opentelemetry/api";
import { env } from "../config/env.js";

declare module "fastify" {
  interface FastifyRequest {
    startTime?: [number, number];
  }
}

const register = new client.Registry<client.OpenMetricsContentType>();

// OpenMetrics format is required for exemplar support.
// prom-client throws "Exemplars are supported only on OpenMetrics registries"
// if this is omitted. It also enables the # {trace_id="..."} exemplar syntax
// that Prometheus needs to persist and expose exemplar data.
register.setContentType(client.Registry.OPENMETRICS_CONTENT_TYPE);

client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [register],
  enableExemplars: true,
});

const httpRequestsInFlight = new client.Gauge({
  name: "http_requests_in_flight",
  help: "Current number of in-flight HTTP requests",
  registers: [register],
});

// ─── Phase 15: Security Metrics ───────────────────────────────────────────────

/**
 * Incremented every time a request is rejected with HTTP 429 (rate limited).
 * Labelled by route so abusive endpoints can be identified at a glance.
 */
export const securityRateLimitHits = new client.Counter({
  name: "security_rate_limit_hits_total",
  help: "Total number of requests rejected by the rate limiter (HTTP 429)",
  labelNames: ["route"],
  registers: [register],
});

/**
 * Incremented every time an auth endpoint (e.g. login) is rate-limited,
 * indicating a possible brute-force attack attempt.
 * Labelled by ip to surface the source of repeated attempts.
 */
export const securityAuthBruteforce = new client.Counter({
  name: "security_auth_bruteforce_total",
  help: "Total number of auth endpoint requests blocked by rate limiting (brute-force signal)",
  labelNames: ["ip"],
  registers: [register],
});

// ─── Phase 21: Analytics Worker Metrics ──────────────────────────────────────

/**
 * Counts completed and failed analytics jobs.
 * Label `status` is either "completed" or "failed".
 */
export const analyticsJobsTotal = new client.Counter({
  name: "analytics_jobs_total",
  help: "Total number of analytics aggregation jobs processed",
  labelNames: ["status"],
  registers: [register],
});

/**
 * Histogram of analytics job processing time in seconds.
 * Used to detect slow aggregation jobs (bucket at 0.5 s meets the 500 ms warn threshold).
 */
export const analyticsJobDurationSeconds = new client.Histogram({
  name: "analytics_job_duration_seconds",
  help: "Analytics job processing time in seconds",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

/**
 * Current depth of the analytics BullMQ queue (waiting jobs).
 * Updated on each Prometheus scrape via a gauge collector.
 */
export const analyticsQueueDepthGauge = new client.Gauge({
  name: "analytics_queue_depth",
  help: "Number of analytics jobs currently waiting in the queue",
  registers: [register],
  collect() {
    // Populated asynchronously by the analytics queue module at scrape time.
    // See analytics.queue.ts getAnalyticsQueueDepth() wiring in prometheus.ts.
  },
});

// ─── Phase 22: Analytics Reliability Metrics ──────────────────────────────────

/**
 * Counts analytics jobs that permanently failed after exhausting all retry
 * attempts.  Used in the Prometheus alert rule `AnalyticsJobFailuresHigh`.
 * Distinct from `analyticsJobsTotal{status="failed"}` so the alert expression
 * stays clean and does not conflate partial retries with permanent failures.
 */
export const analyticsJobFailuresTotal = new client.Counter({
  name: "analytics_job_failures_total",
  help: "Total number of analytics jobs that permanently failed after all retries",
  registers: [register],
});

/**
 * Counts each retry attempt of an analytics job (i.e. every non-first attempt).
 * Useful for spotting whether a class of sessions is consistently bouncing
 * before eventually succeeding or failing permanently.
 */
export const analyticsJobRetriesTotal = new client.Counter({
  name: "analytics_job_retries_total",
  help: "Total number of analytics job retry attempts (attempt > 0)",
  registers: [register],
});

const prometheusPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", async (request) => {
    request.startTime = process.hrtime();
    httpRequestsInFlight.inc();
  });

  fastify.addHook("onResponse", async (request, reply) => {
    if (!request.startTime) return;

    const diff = process.hrtime(request.startTime);
    const duration = diff[0] + diff[1] / 1e9;

    let route =
      request.routerPath ??
      request.routeOptions?.url ??
      request.raw.url?.split("?")[0] ??
      "unknown";

    if (route.startsWith("/smart-wire/")) {
      route = "/smart-wire/:slug";
    }

    if (route === "/metrics") {
      httpRequestsInFlight.dec();
      return;
    }

    httpRequestsTotal
      .labels(request.method, route, String(reply.statusCode))
      .inc();

    // Attach the active trace ID as an exemplar so Grafana can jump from
    // this metric data point straight to the corresponding Tempo trace.
    const activeSpan = trace.getSpan(context.active());
    const traceId = activeSpan?.spanContext().traceId;

    httpRequestDuration.observe({
      labels: { method: request.method, route, status_code: String(reply.statusCode) },
      value: duration,
      exemplarLabels: traceId !== undefined
        ? ({ trace_id: traceId } as Record<string, string>)
        : undefined,
    });

    httpRequestsInFlight.dec();
  });

  fastify.addHook("onError", async (request) => {
    if (request.startTime) {
      httpRequestsInFlight.dec();
    }
  });

  fastify.get("/metrics", async (request, reply) => {
    // Require a shared secret token when one is configured.
    // In development (token undefined) the endpoint remains open.
    if (env.METRICS_SCRAPE_TOKEN !== undefined) {
      const token = request.headers["x-metrics-token"];
      if (token !== env.METRICS_SCRAPE_TOKEN) {
        await reply.status(401).send("Unauthorized");
        return;
      }
    }
    reply.header("Content-Type", register.contentType);
    return register.metrics();
  });
};

export default fp(prometheusPlugin, {
  name: "prometheus-plugin",
});
