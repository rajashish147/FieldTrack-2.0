import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../../../src/config/redis.js", () => ({
  redisClient: { on: vi.fn(), quit: vi.fn(), disconnect: vi.fn() },
}));

vi.mock("../../../src/workers/distance.queue.js", () => ({
  enqueueDistanceJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/workers/analytics.queue.js", () => ({
  enqueueAnalyticsJob: vi.fn().mockResolvedValue(undefined),
}));

// The map route calls supabaseServiceClient.rpc("get_active_map_markers", ...)
vi.mock("../../../src/config/supabase.js", () => ({
  supabaseServiceClient: { rpc: vi.fn() },
}));

vi.mock("../../../src/auth/jwtVerifier.js", () => ({
  verifySupabaseToken: vi.fn().mockImplementation(async (token: string) => {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT structure");
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  }),
}));

import {
  buildTestApp,
  signEmployeeToken,
  signAdminToken,
  TEST_EMPLOYEE_ID,
  TEST_SESSION_ID,
} from "../../setup/test-server.js";
import { supabaseServiceClient as supabase } from "../../../src/config/supabase.js";
import type { EmployeeMapMarker } from "@fieldtrack/types";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const EMPLOYEE_ID_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SESSION_ID_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date().toISOString();
const EARLIER = new Date(Date.now() - 300_000).toISOString(); // 5 min ago

/**
 * Rows returned by get_active_map_markers — flat, DISTINCT ON already applied
 * in the DB function. The most recent GPS point per employee is returned directly.
 */
const RPC_ROWS = [
  {
    employee_id: TEST_EMPLOYEE_ID,
    latitude: 1.3521,
    longitude: 103.8198,
    recorded_at: NOW,
    employee_name: "Test Employee",
    employee_code: "EMP001",
    status: "ACTIVE",
    session_id: TEST_SESSION_ID,
  },
  {
    employee_id: EMPLOYEE_ID_2,
    latitude: 1.28,
    longitude: 103.85,
    recorded_at: EARLIER,
    employee_name: "Second Employee",
    employee_code: "EMP002",
    status: "RECENT",
    session_id: SESSION_ID_2,
  },
] as const;

type RpcRow = (typeof RPC_ROWS)[number];

function mockMapRpc(rows: readonly RpcRow[] | RpcRow[] = RPC_ROWS): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(supabase.rpc as (...args: unknown[]) => any).mockResolvedValue({
    data: rows,
    error: null,
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
    mockMapRpc();
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
    // DISTINCT ON in the RPC function guarantees the most recent GPS point per employee
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
    mockMapRpc([]);

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
    // The RPC JOIN naturally excludes employees with no GPS rows.
    // Simulate this by returning only EMP001's row from the RPC.
    mockMapRpc([RPC_ROWS[0]]);

    const res = await app.inject({
      method: "GET",
      url: "/admin/monitoring/map",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const body = res.json<{ data: EmployeeMapMarker[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.employeeId).toBe(TEST_EMPLOYEE_ID);
  });

  // ─── Error paths ──────────────────────────────────────────────────────────

  it("returns 500 when the snapshot query fails", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(supabase.rpc as (...args: unknown[]) => any).mockResolvedValue({
      data: null,
      error: { message: "DB error" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/monitoring/map",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(500);
  });

  it("returns 500 when the GPS query fails", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(supabase.rpc as (...args: unknown[]) => any).mockResolvedValue({
      data: null,
      error: { message: "GPS table unavailable" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/monitoring/map",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(500);
  });
});
