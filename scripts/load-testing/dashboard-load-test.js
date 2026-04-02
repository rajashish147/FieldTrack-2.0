/**
 * FieldTrack Phase 23 — Dashboard Load Test
 *
 * Simulates 50 concurrent admin users polling the dashboard and sessions
 * endpoints over a 2-minute steady state period.
 *
 * Run:
 *   k6 run dashboard-load-test.js \
 *     -e BASE_URL=https://api.getfieldtrack.app \
 *     -e ADMIN_TOKEN=<JWT>
 *
 * Performance targets:
 *   p95 latency < 1000 ms  (/admin/dashboard)
 *   p95 latency < 800 ms   (/admin/sessions)
 *   error rate  < 1 %
 *
 * NOTE on rate limiting:
 *   All 50 VUs share a single ADMIN_TOKEN, so they appear as ONE user to the
 *   per-token rate limiter (1200 req/min).  50 VUs × ~12 req/min ≈ 600 req/min
 *   — comfortably within budget.  In production, 50 real admins would each hold
 *   their own token and each get the full 1200 req/min quota.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

// ─── Custom metrics ─────────────────────────────────────────────────────────

const dashboardDuration = new Trend("dashboard_duration_ms", true);
const sessionsDuration = new Trend("sessions_duration_ms", true);
const errorRate = new Rate("error_rate");
const requestsTotal = new Counter("requests_total");

// ─── Test options ────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    dashboard_polling: {
      executor: "constant-vus",
      vus: 50,
      duration: "2m",
    },
  },
  thresholds: {
    // Performance targets updated in Phase 24 (O(1) snapshot query)
    dashboard_duration_ms: ["p(95)<1000"],
    sessions_duration_ms: ["p(95)<800"],
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
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip, br",
  };
}

// ─── Default scenario ─────────────────────────────────────────────────────────

export default function () {
  const headers = authHeaders();

  // ── /admin/dashboard ─────────────────────────────────────────────────────
  const dashRes = http.get(`${BASE_URL}/admin/dashboard`, { headers, tags: { name: "admin_dashboard" } });
  requestsTotal.add(1);
  dashboardDuration.add(dashRes.timings.duration);

  // Correctness check — only logical failures increment error_rate
  const dashOk = check(dashRes, {
    "dashboard status 200": (r) => r.status === 200,
    "dashboard response is success": (r) => {
      try { return JSON.parse(r.body).success === true; } catch { return false; }
    },
    "dashboard has activeEmployeeCount": (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.data?.activeEmployeeCount === "number";
      } catch {
        return false;
      }
    },
  });
  // Latency check — observability only, does not affect error_rate
  check(dashRes, { "dashboard response time < 500ms": (r) => r.timings.duration < 500 });
  errorRate.add(!dashOk);

  sleep(0.5);

  // ── /admin/sessions ──────────────────────────────────────────────────────
  const sessRes = http.get(`${BASE_URL}/admin/sessions?limit=50`, { headers, tags: { name: "admin_sessions" } });
  requestsTotal.add(1);
  sessionsDuration.add(sessRes.timings.duration);

  // Correctness check — only logical failures increment error_rate
  const sessOk = check(sessRes, {
    "sessions status 200": (r) => r.status === 200,
    "sessions response is success": (r) => {
      try { return JSON.parse(r.body).success === true; } catch { return false; }
    },
    "sessions has pagination": (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.pagination?.total === "number";
      } catch {
        return false;
      }
    },
  });
  // Latency check — observability only, does not affect error_rate
  check(sessRes, { "sessions response time < 500ms": (r) => r.timings.duration < 500 });
  errorRate.add(!sessOk);

  // Simulate realistic admin polling cadence — 5 s between full refreshes
  sleep(5);
}
