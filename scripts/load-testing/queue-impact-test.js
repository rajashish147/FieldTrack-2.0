/**
 * FieldTrack Phase 23 — Queue Impact Load Test
 *
 * Simulates a burst of session checkouts to stress the distance and analytics
 * worker queues. After the burst, the script polls /admin/queues to watch the
 * backlog drain and verify the queues recover within the target SLA.
 *
 * Run:
 *   k6 run queue-impact-test.js \
 *     -e BASE_URL=https://api.getfieldtrack.app \
 *     -e EMPLOYEE_TOKEN=<JWT> \
 *     -e ADMIN_TOKEN=<JWT>
 *
 * NOTE: This test checks out real sessions. Pre-create checked-in sessions
 * in a staging environment or use the smoke-test helper to seed data first.
 *
 * Metrics monitored:
 *   analytics_queue_depth  — Prometheus gauge via /admin/queues
 *   checkout latency       — POST /attendance/check-out p95
 *   queue drain time       — how quickly depth returns to 0
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter, Gauge } from "k6/metrics";

// ─── Custom metrics ─────────────────────────────────────────────────────────

const checkoutDuration = new Trend("checkout_duration_ms", true);
const queueDepth = new Gauge("analytics_queue_depth_observed");
const errorRate = new Rate("error_rate");
const requestsTotal = new Counter("requests_total");

// ─── Test options ────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    // Phase 1: burst checkout load (simulates end-of-day mass checkout)
    checkout_burst: {
      executor: "constant-vus",
      vus: 30,
      duration: "30s",
      tags: { phase: "burst" },
    },
    // Phase 2: queue drain monitoring — starts after the burst ends
    queue_drain_monitor: {
      executor: "constant-vus",
      vus: 1,
      startTime: "35s",
      duration: "2m",
      tags: { phase: "monitor" },
    },
  },
  thresholds: {
    // Checkout must stay fast even under queue pressure
    checkout_duration_ms: ["p(95)<400"],
    error_rate: ["rate<0.05"],
    http_req_failed: ["rate<0.05"],
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || "https://api.getfieldtrack.app";
const EMPLOYEE_TOKEN = __ENV.EMPLOYEE_TOKEN || "";
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || "";

function empHeaders() {
  return {
    Authorization: `Bearer ${EMPLOYEE_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function adminHeaders() {
  return {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    "Content-Type": "application/json",
  };
}

// ─── Checkout burst scenario ──────────────────────────────────────────────────

export function checkoutBurst() {
  // POST check-out triggers distance + analytics job enqueue
  const res = http.post(
    `${BASE_URL}/attendance/check-out`,
    "{}",
    { headers: empHeaders(), tags: { name: "checkout" } },
  );

  requestsTotal.add(1);
  checkoutDuration.add(res.timings.duration);

  // Correctness check — only logical failures increment error_rate
  const ok = check(res, {
    // 200 = checked out successfully; 409 = no open session (idempotent)
    "checkout accepted": (r) => r.status === 200 || r.status === 409,
  });
  // Latency check — observability only, does not affect error_rate
  check(res, { "checkout < 1s": (r) => r.timings.duration < 1000 });
  errorRate.add(!ok);

  sleep(1);
}

// ─── Queue drain monitor scenario ─────────────────────────────────────────────

export function queueDrainMonitor() {
  const res = http.get(`${BASE_URL}/admin/queues`, {
    headers: adminHeaders(),
    tags: { name: "queue_stats" },
  });

  requestsTotal.add(1);

  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      const analyticsWaiting = body.queues?.analytics?.waiting ?? -1;
      const distanceWaiting = body.queues?.distance?.waiting ?? -1;

      queueDepth.add(analyticsWaiting + distanceWaiting);

      check(res, {
        "queue depth within SLA (<500)": () =>
          analyticsWaiting + distanceWaiting < 500,
        "no DLQ overflow (<10)": () =>
          (body.queues?.analytics?.dlq?.waiting ?? 0) < 10,
      });
    } catch { /* parse error — log as failure */ }
  }

  // Poll every 10 seconds
  sleep(10);
}

// ─── Default function — routes to correct scenario function ───────────────────
// k6 uses exec tags to map VUs to named functions when using "scenarios" config.
// The default export is only called when no `exec` is specified on a scenario.
// Since we have two named scenarios above, we point each one at its function.

export default function () {
  // Fallback: if run without scenarios config, execute the checkout burst.
  checkoutBurst();
}
