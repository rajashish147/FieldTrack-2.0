import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../../../src/config/redis.js", () => ({
  redisClient: { on: vi.fn(), quit: vi.fn(), disconnect: vi.fn() },
}));

vi.mock("../../../src/workers/distance.queue.js", () => ({
  enqueueDistanceJob: vi.fn().mockResolvedValue(undefined),
}));

// The map route calls supabaseServiceClient.from() for employee_latest_sessions
// and gps_locations tables.
vi.mock("../../../src/config/supabase.js", () => ({
  supabaseServiceClient: { from: vi.fn() },
}));

import {
  buildTestApp,
  signEmployeeToken,
  signAdminToken,
  TEST_ORG_ID,
  TEST_EMPLOYEE_ID,
  TEST_SESSION_ID,
} from "../../setup/test-server.js";
import { supabaseServiceClient as supabase } from "../../../src/config/supabase.js";
import type { EmployeeMapMarker } from "@fieldtrack/types";

// ─── Supabase builder factory ─────────────────────────────────────────────────

function makeChainBuilder(result: { data: unknown; error: null | { message: string } }) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "eq", "gte", "in", "order", "range", "limit"];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  (chain as { then: (r: (v: unknown) => void) => Promise<unknown> }).then = (resolve) =>
    Promise.resolve(result).then(resolve);
  return chain as {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    in: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    then: (r: (v: unknown) => void) => Promise<unknown>;
  };
}

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const EMPLOYEE_ID_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SESSION_ID_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date().toISOString();
const EARLIER = new Date(Date.now() - 300_000).toISOString(); // 5 min ago

const SNAPSHOT_ROWS = [
  {
    employee_id: TEST_EMPLOYEE_ID,
    employee_name: "Test Employee",
    employee_code: "EMP001",
    status: "ACTIVE",
    session_id: TEST_SESSION_ID,
  },
  {
    employee_id: EMPLOYEE_ID_2,
    employee_name: "Second Employee",
    employee_code: "EMP002",
    status: "RECENT",
    session_id: SESSION_ID_2,
  },
];

const GPS_ROWS = [
  {
    session_id: TEST_SESSION_ID,
    employee_id: TEST_EMPLOYEE_ID,
    latitude: 1.3521,
    longitude: 103.8198,
    recorded_at: NOW,
  },
  {
    session_id: TEST_SESSION_ID,
    employee_id: TEST_EMPLOYEE_ID,
    latitude: 1.300,
    longitude: 103.800,
    recorded_at: EARLIER, // older — should be ignored for deduplication
  },
  {
    session_id: SESSION_ID_2,
    employee_id: EMPLOYEE_ID_2,
    latitude: 1.2800,
    longitude: 103.8500,
    recorded_at: EARLIER,
  },
];

function mockMapSupabase(): void {
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    if (table === "employee_latest_sessions") {
      return makeChainBuilder({ data: SNAPSHOT_ROWS, error: null });
    }
    if (table === "gps_locations") {
      return makeChainBuilder({ data: GPS_ROWS, error: null });
    }
    return makeChainBuilder({ data: [], error: null });
  });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("GET /admin/monitoring/map", () => {
  let app: FastifyInstance;
  let employeeToken: string;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    employeeToken = signEmployeeToken(app);
    adminToken = signAdminToken(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockMapSupabase();
  });

  // ─── Auth & role guards ───────────────────────────────────────────────────

  it("returns 401 when no JWT is provided", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/monitoring/map" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when called with an employee token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/monitoring/map",
      headers: { authorization: `Bearer ${employeeToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── Happy path ───────────────────────────────────────────────────────────

  it("returns 200 with one marker per employee", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/monitoring/map",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; data: EmployeeMapMarker[] }>();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
  });

  it("returns the most recent GPS point for each employee", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/monitoring/map",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const body = res.json<{ data: EmployeeMapMarker[] }>();
    const marker = body.data.find((m) => m.employeeId === TEST_EMPLOYEE_ID);

    expect(marker).toBeDefined();
    // Should use the newer point (NOW), not the EARLIER one
    expect(marker?.latitude).toBeCloseTo(1.3521);
    expect(marker?.longitude).toBeCloseTo(103.8198);
    expect(marker?.recordedAt).toBe(NOW);
  });

  it("includes correct status and employee metadata", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/monitoring/map",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const body = res.json<{ data: EmployeeMapMarker[] }>();
    const marker = body.data.find((m) => m.employeeId === TEST_EMPLOYEE_ID);

    expect(marker?.status).toBe("ACTIVE");
    expect(marker?.employeeName).toBe("Test Employee");
    expect(marker?.employeeCode).toBe("EMP001");
    expect(marker?.sessionId).toBe(TEST_SESSION_ID);
  });

  it("returns empty array when no employees exist", async () => {
    vi.mocked(supabase.from).mockImplementation(() =>
      makeChainBuilder({ data: [], error: null }),
    );

    const res = await app.inject({
      method: "GET",
      url: "/admin/monitoring/map",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(0);
  });

  it("omits employees who have no GPS points in their session", async () => {
    // Only EMP001 has GPS data; EMP002's session has no GPS rows
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "employee_latest_sessions") {
        return makeChainBuilder({ data: SNAPSHOT_ROWS, error: null });
      }
      if (table === "gps_locations") {
        // Only include GPS row for EMP001's session
        return makeChainBuilder({
          data: [GPS_ROWS[0]],
          error: null,
        });
      }
      return makeChainBuilder({ data: [], error: null });
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/monitoring/map",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const body = res.json<{ data: EmployeeMapMarker[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].employeeId).toBe(TEST_EMPLOYEE_ID);
  });

  it("returns 500 when the snapshot query fails", async () => {
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "employee_latest_sessions") {
        return makeChainBuilder({ data: null, error: { message: "DB error" } });
      }
      return makeChainBuilder({ data: [], error: null });
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/monitoring/map",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(500);
  });

  it("returns 500 when the GPS query fails", async () => {
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "employee_latest_sessions") {
        return makeChainBuilder({ data: SNAPSHOT_ROWS, error: null });
      }
      if (table === "gps_locations") {
        return makeChainBuilder({ data: null, error: { message: "GPS table unavailable" } });
      }
      return makeChainBuilder({ data: [], error: null });
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/monitoring/map",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(500);
  });
});
