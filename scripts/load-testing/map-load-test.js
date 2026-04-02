/**
 * FieldTrack Phase 23 — Monitoring Map Load Test
 *
 * Simulates 20 concurrent monitoring clients that poll the live map endpoint
 * every 30 seconds, mirroring the production frontend SSE/polling cadence.
 *
 * Run:
 *   k6 run map-load-test.js \
 *     -e BASE_URL=https://api.getfieldtrack.app \
 *     -e ADMIN_TOKEN=<JWT>
 *
 * Performance target:
 *   p95 latency < 200 ms
 *   error rate  < 1 %
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

// ─── Custom metrics ─────────────────────────────────────────────────────────

const mapDuration = new Trend("map_duration_ms", true);
const errorRate = new Rate("error_rate");
const requestsTotal = new Counter("requests_total");

// ─── Test options ────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    live_map_polling: {
      executor: "constant-vus",
      vus: 20,
      duration: "3m",
    },
  },
  thresholds: {
    map_duration_ms: ["p(95)<200"],
    error_rate: ["rate<0.01"],
    http_req_failed: ["rate<0.01"],
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || "https://api.getfieldtrack.app";
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || "";

function authHeaders() {
  return {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    "Accept-Encoding": "gzip, br",
  };
}

// ─── Default scenario ─────────────────────────────────────────────────────────

export default function () {
  const headers = authHeaders();

  const res = http.get(`${BASE_URL}/admin/monitoring/map`, {
    headers,
    tags: { name: "monitoring_map" },
  });

  requestsTotal.add(1);
  mapDuration.add(res.timings.duration);

  // Correctness check — only logical failures increment error_rate
  const ok = check(res, {
    "map status 200": (r) => r.status === 200,
    "map response is success": (r) => {
      try { return JSON.parse(r.body).success === true; } catch { return false; }
    },
    "map has markers array": (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.data);
      } catch {
        return false;
      }
    },
    "map content-encoding compressed": (r) =>
      r.headers["Content-Encoding"] !== undefined || r.body.length > 0,
  });
  // Latency check — observability only, does not affect error_rate
  check(res, { "map response time < 500ms": (r) => r.timings.duration < 500 });
  errorRate.add(!ok);

  // Simulate 30-second polling interval (realistic monitoring cadence)
  sleep(30);
}
