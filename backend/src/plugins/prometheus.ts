import type { FastifyPluginAsync } from "fastify";
import type { IncomingMessage } from "http";
import client from "prom-client";

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

// WeakMap keyed on the raw Node IncomingMessage — avoids patching request.raw
// and survives the full Fastify request lifecycle without memory leaks.
const timings = new WeakMap<IncomingMessage, [number, number]>();

const prometheusPlugin: FastifyPluginAsync = async (fastify) => {
  // Start a high-resolution timer on every incoming request.
  fastify.addHook("onRequest", (request, _reply, done) => {
    timings.set(request.raw, process.hrtime());
    done();
  });

  // On response: compute elapsed time, record histogram + counter.
  // Skips the /metrics route itself to avoid self-referential noise.
  fastify.addHook("onResponse", (request, reply, done) => {
    const route = request.routeOptions?.url ?? request.url;

    if (route === "/metrics") {
      done();
      return;
    }

    const start = timings.get(request.raw);

    if (start !== undefined) {
      const diff = process.hrtime(start);
      const seconds = diff[0] + diff[1] / 1e9;
      const labels = {
        method: request.method,
        route,
        status_code: String(reply.statusCode),
      };

      httpRequestDuration.labels(labels).observe(seconds);
      httpRequestsTotal.labels(labels).inc();
      timings.delete(request.raw);
    }

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
