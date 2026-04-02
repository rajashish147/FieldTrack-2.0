/**
 * FieldTrack Phase 23 — Expense Workflow Load Test
 *
 * Simulates 100 concurrent employees submitting expense claims and then
 * retrieving their expense list. Validates that the API remains responsive
 * under realistic bulk-submission conditions (e.g. end-of-month expense flush).
 *
 * Run:
 *   k6 run expenses-load-test.js \
 *     -e BASE_URL=https://api.getfieldtrack.app \
 *     -e EMPLOYEE_TOKEN=<JWT>
 *
 * NOTE: This test writes real data. Run against a staging environment or clean
 * up submitted expenses afterwards via the Supabase dashboard / admin API.
 *
 * Performance targets:
 *   POST /expenses p95 < 300 ms
 *   GET  /expenses/my p95 < 200 ms
 *   error rate < 1 %
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

// ─── Custom metrics ─────────────────────────────────────────────────────────

const submitDuration = new Trend("expense_submit_duration_ms", true);
const listDuration = new Trend("expense_list_duration_ms", true);
const errorRate = new Rate("error_rate");
const requestsTotal = new Counter("requests_total");

// ─── Test options ────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    expense_submission: {
      executor: "constant-vus",
      vus: 100,
      duration: "2m",
    },
  },
  thresholds: {
    expense_submit_duration_ms: ["p(95)<300"],
    expense_list_duration_ms: ["p(95)<200"],
    error_rate: ["rate<0.01"],
    http_req_failed: ["rate<0.01"],
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || "https://api.getfieldtrack.app";
// Each VU can use the same employee token in a load test (shared org context)
const EMPLOYEE_TOKEN = __ENV.EMPLOYEE_TOKEN || "";

function authHeaders() {
  return {
    Authorization: `Bearer ${EMPLOYEE_TOKEN}`,
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip, br",
  };
}

// ─── Default scenario ─────────────────────────────────────────────────────────

export default function () {
  const headers = authHeaders();
  const vu = __VU;
  const iter = __ITER;

  // ── POST /expenses — submit a new expense claim ───────────────────────────
  const payload = JSON.stringify({
    amount: Math.round((10 + Math.random() * 490) * 100) / 100,
    description: `Load test expense — VU ${vu} iteration ${iter}`,
  });

  const submitRes = http.post(`${BASE_URL}/expenses`, payload, {
    headers,
    tags: { name: "expense_submit" },
  });

  requestsTotal.add(1);
  submitDuration.add(submitRes.timings.duration);

  // Correctness check — only logical failures increment error_rate
  const submitOk = check(submitRes, {
    "expense submit 201": (r) => r.status === 201,
    "expense response is success": (r) => {
      try { return JSON.parse(r.body).success === true; } catch { return false; }
    },
    "expense has id": (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.data?.id === "string";
      } catch {
        return false;
      }
    },
  });
  // Latency check — observability only, does not affect error_rate
  check(submitRes, { "expense submit < 1s": (r) => r.timings.duration < 1000 });
  errorRate.add(!submitOk);

  sleep(1);

  // ── GET /expenses/my — list own expenses ──────────────────────────────────
  const listRes = http.get(`${BASE_URL}/expenses/my?limit=20`, {
    headers,
    tags: { name: "expense_list" },
  });

  requestsTotal.add(1);
  listDuration.add(listRes.timings.duration);

  const listOk = check(listRes, {
    "expense list 200": (r) => r.status === 200,
    "expense list response is success": (r) => {
      try { return JSON.parse(r.body).success === true; } catch { return false; }
    },
    "expense list has pagination": (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.pagination?.total === "number";
      } catch {
        return false;
      }
    },
  });
  errorRate.add(!listOk);

  // Simulate realistic inter-request think time
  sleep(2 + Math.random() * 3);
}
