import type { FastifyPluginAsync } from "fastify";
import client from "prom-client";

declare module "fastify" {
  interface FastifyRequest {
    startTime?: [number, number];
  }
}

// Create isolated Prometheus registry
const register = new client.Registry();

// Collect default Node.js metrics
client.collectDefaultMetrics({ register });

/* -------------------------------------------------------------------------- */
/*                                  Metrics                                   */
/* -------------------------------------------------------------------------- */

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
});

const httpRequestsInFlight = new client.Gauge({
  name: "http_requests_in_flight",
  help: "Current number of in-flight HTTP requests",
  registers: [register],
});

/* -------------------------------------------------------------------------- */
/*                              Fastify Plugin                                */
/* -------------------------------------------------------------------------- */

const prometheusPlugin: FastifyPluginAsync = async (fastify) => {

  /* --------------------------- Request Start Hook -------------------------- */

  fastify.addHook("onRequest", async (request) => {
    request.startTime = process.hrtime();
    httpRequestsInFlight.inc();
  });

  /* -------------------------- Response Complete Hook ----------------------- */

  fastify.addHook("onResponse", async (request, reply) => {
    if (!request.startTime) return;

    const diff = process.hrtime(request.startTime);
    const duration = diff[0] + diff[1] / 1e9;

    const route =
      (request as any).routerPath ??
      request.routeOptions?.url ??
      request.raw.url?.split("?")[0] ??
      "unknown";

    // Skip self-scraping
    if (route === "/metrics") {
      httpRequestsInFlight.dec();
      return;
    }

    httpRequestsTotal
      .labels(request.method, route, String(reply.statusCode))
      .inc();

    httpRequestDuration
      .labels(request.method, route, String(reply.statusCode))
      .observe(duration);

    httpRequestsInFlight.dec();
  });

  /* ----------------------------- Error Hook -------------------------------- */

  fastify.addHook("onError", async (request) => {
    if (request.startTime) {
      httpRequestsInFlight.dec();
    }
  });

  /* ----------------------------- Metrics Route ----------------------------- */

  fastify.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", register.contentType);
    return register.metrics();
  });
};

export default prometheusPlugin;