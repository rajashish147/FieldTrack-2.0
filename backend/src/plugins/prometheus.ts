import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import client from "prom-client";
import { trace, context } from "@opentelemetry/api";

declare module "fastify" {
  interface FastifyRequest {
    startTime?: [number, number];
  }
}

const register = new client.Registry();
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
      (request as any).routerPath ??
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

  fastify.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", register.contentType);
    return register.metrics();
  });
};

export default fp(prometheusPlugin, {
  name: "prometheus-plugin",
});
