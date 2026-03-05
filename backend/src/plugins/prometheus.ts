import type { FastifyPluginAsync } from "fastify";
import client from "prom-client";

declare module "fastify" {
  interface FastifyRequest {
    startTime?: [number, number];
    routerPath?: string;
  }
}

// Isolated registry — avoids polluting the global prom-client default registry
// in case other libraries also use prom-client internally.
const register = new client.Registry();

// Default Node.js metrics: CPU usage, heap, event-loop lag, GC, libuv handles.
client.collectDefaultMetrics({ register });

// ─── HTTP Request Metrics ────────────────────────────────────────────────────

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
  // Buckets tuned for a JSON API: 10ms → 5s
  buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [register],
});

const prometheusPlugin: FastifyPluginAsync = async (fastify) => {
  // Start a high-resolution timer on every incoming request.
  fastify.addHook("onRequest", (request, _reply, done) => {
    request.startTime = process.hrtime();
    done();
  });

  // On response: compute elapsed time, record histogram + counter.
  // Skips the /metrics route itself to avoid self-referential noise.
  fastify.addHook("onResponse", (request, reply, done) => {
    if (!request.startTime) {
      done();
      return;
    }

    const diff = process.hrtime(request.startTime);
    const duration = diff[0] + diff[1] / 1e9;

    const route =
      request.routeOptions?.url ||
      request.routerPath ||
      request.raw.url ||
      "unknown";

    if (route === "/metrics") {
      done();
      return;
    }

    httpRequestsTotal.inc({
      method: request.method,
      route,
      status_code: reply.statusCode
    });

    httpRequestDuration.observe(
      {
        method: request.method,
        route,
        status_code: reply.statusCode
      },
      duration
    );

    done();
  });

  // Prometheus scrape endpoint — unauthenticated, internal scraping only.
  fastify.get("/metrics", async (_request, reply) => {
    await reply
      .header("Content-Type", register.contentType)
      .send(await register.metrics());
  });
};

export default prometheusPlugin;
