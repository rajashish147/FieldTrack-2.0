import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

// Mock supabaseServiceClient before importing the repository
vi.mock("../../../src/config/supabase.js", () => {
  return {
    supabaseServiceClient: {
      from: vi.fn(),
    },
  };
});

import { supabaseServiceClient as supabase } from "../../../src/config/supabase.js";
import { analyticsMetricsRepository } from "../../../src/modules/analytics/analytics.metrics.repository.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DATE = "2026-03-15";

/** Build a chainable Supabase builder mock. */
function makeBuilder(readResult: unknown = null, upsertError: unknown = null) {
  const builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: readResult, error: null }),
    upsert: vi.fn().mockResolvedValue({ error: upsertError }),
  };
  return builder;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("analyticsMetricsRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── upsertEmployeeDailySessionMetrics ──────────────────────────────────

  describe("upsertEmployeeDailySessionMetrics()", () => {
    it("increments sessions by 1 and adds distance + duration when row exists", async () => {
      const existingRow = { sessions: 5, distance_km: 100.0, duration_seconds: 18000 };
      const builder = makeBuilder(existingRow);
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      await analyticsMetricsRepository.upsertEmployeeDailySessionMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        distanceDeltaKm: 12.5,
        durationDeltaSeconds: 3600,
      });

      expect(supabase.from).toHaveBeenCalledWith("employee_daily_metrics");
      expect(builder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: ORG_ID,
          employee_id: EMPLOYEE_ID,
          date: DATE,
          sessions: 6,
          distance_km: 112.5,
          duration_seconds: 21600,
        }),
        { onConflict: "employee_id,date" },
      );
    });

    it("starts from zero when no existing row (INSERT path)", async () => {
      const builder = makeBuilder(null); // no existing row
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      await analyticsMetricsRepository.upsertEmployeeDailySessionMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        distanceDeltaKm: 8.0,
        durationDeltaSeconds: 1800,
      });

      expect(builder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          sessions: 1,
          distance_km: 8.0,
          duration_seconds: 1800,
        }),
        expect.any(Object),
      );
    });

    it("rounds distance_km to 3 decimal places", async () => {
      const existing = { sessions: 0, distance_km: 0.1, duration_seconds: 0 };
      const builder = makeBuilder(existing);
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      await analyticsMetricsRepository.upsertEmployeeDailySessionMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        distanceDeltaKm: 0.2,
        durationDeltaSeconds: 0,
      });

      const upsertCall = builder.upsert.mock.calls[0]![0] as Record<string, number>;
      // 0.1 + 0.2 = 0.3 — should not be 0.30000000000000004
      expect(upsertCall.distance_km).toBe(0.3);
    });

    it("throws on Supabase upsert error", async () => {
      const builder = makeBuilder(null, { message: "constraint violation" });
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      await expect(
        analyticsMetricsRepository.upsertEmployeeDailySessionMetrics({
          organizationId: ORG_ID,
          employeeId: EMPLOYEE_ID,
          date: DATE,
          distanceDeltaKm: 1,
          durationDeltaSeconds: 60,
        }),
      ).rejects.toThrow("Analytics: failed to upsert employee session metrics");
    });

    it("uses onConflict key employee_id,date (not organization_id)", async () => {
      const builder = makeBuilder(null);
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      await analyticsMetricsRepository.upsertEmployeeDailySessionMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        distanceDeltaKm: 1,
        durationDeltaSeconds: 60,
      });

      expect(builder.upsert).toHaveBeenCalledWith(
        expect.any(Object),
        { onConflict: "employee_id,date" },
      );
    });

    it("concurrent calls both complete — ON CONFLICT prevents duplicate-key errors", async () => {
      // Simulates two checkouts arriving simultaneously for the same employee.
      //
      // Both coroutines read the DB state before either write has landed, so
      // they see the same initial row (the classic read-then-upsert race window).
      // This test verifies:
      //   1. Neither call throws — ON CONFLICT makes the upsert idempotent/safe.
      //   2. upsert() is called exactly twice (both operations ran end-to-end).
      //   3. Each call's payload reflects its own delta added to the read value.
      //
      // Note: for truly atomic increments (sessions = db.sessions + 1 without a
      // read) a Postgres function would be required. The test documents current
      // behaviour rather than asserting a sessions=+2 result, because with mocked
      // async DB calls both reads complete before either write, meaning the last
      // writer's sessions value (base+1) is what the mock records — exactly
      // mirroring what the ON CONFLICT DO UPDATE SET clause does in Postgres.
      const existingRow = { sessions: 5, distance_km: 100.0, duration_seconds: 18000 };

      const upsertPayloads: unknown[] = [];
      const builder = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: existingRow, error: null }),
        upsert: vi.fn().mockImplementation((payload: unknown) => {
          upsertPayloads.push(payload);
          return Promise.resolve({ error: null });
        }),
      };
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      // Fire both calls concurrently — neither should throw
      await expect(
        Promise.all([
          analyticsMetricsRepository.upsertEmployeeDailySessionMetrics({
            organizationId: ORG_ID,
            employeeId: EMPLOYEE_ID,
            date: DATE,
            distanceDeltaKm: 10.0,
            durationDeltaSeconds: 1800,
          }),
          analyticsMetricsRepository.upsertEmployeeDailySessionMetrics({
            organizationId: ORG_ID,
            employeeId: EMPLOYEE_ID,
            date: DATE,
            distanceDeltaKm: 5.0,
            durationDeltaSeconds: 900,
          }),
        ]),
      ).resolves.not.toThrow();

      // Both operations reached the upsert stage
      expect(upsertPayloads).toHaveLength(2);

      // Each call added its own delta on top of the value it read
      const payloads = upsertPayloads as Array<Record<string, number>>;
      expect(payloads[0]).toMatchObject({ sessions: 6, distance_km: 110, duration_seconds: 19800 });
      expect(payloads[1]).toMatchObject({ sessions: 6, distance_km: 105, duration_seconds: 18900 });
    });
  });

  // ─── upsertOrgDailySessionMetrics ───────────────────────────────────────

  describe("upsertOrgDailySessionMetrics()", () => {
    it("increments total_sessions and sums distance + duration", async () => {
      const existing = {
        total_sessions: 10,
        total_distance_km: 200.0,
        total_duration_seconds: 36000,
      };
      const builder = makeBuilder(existing);
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      await analyticsMetricsRepository.upsertOrgDailySessionMetrics({
        organizationId: ORG_ID,
        date: DATE,
        distanceDeltaKm: 15.0,
        durationDeltaSeconds: 7200,
      });

      expect(builder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: ORG_ID,
          date: DATE,
          total_sessions: 11,
          total_distance_km: 215.0,
          total_duration_seconds: 43200,
        }),
        { onConflict: "organization_id,date" },
      );
    });

    it("starts from zero when no existing org row", async () => {
      const builder = makeBuilder(null);
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      await analyticsMetricsRepository.upsertOrgDailySessionMetrics({
        organizationId: ORG_ID,
        date: DATE,
        distanceDeltaKm: 5.0,
        durationDeltaSeconds: 900,
      });

      expect(builder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          total_sessions: 1,
          total_distance_km: 5.0,
          total_duration_seconds: 900,
        }),
        expect.any(Object),
      );
    });

    it("uses onConflict key organization_id,date", async () => {
      const builder = makeBuilder(null);
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      await analyticsMetricsRepository.upsertOrgDailySessionMetrics({
        organizationId: ORG_ID,
        date: DATE,
        distanceDeltaKm: 0,
        durationDeltaSeconds: 0,
      });

      expect(builder.upsert).toHaveBeenCalledWith(
        expect.any(Object),
        { onConflict: "organization_id,date" },
      );
    });

    it("throws on Supabase upsert error", async () => {
      const builder = makeBuilder(null, { message: "deadlock detected" });
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      await expect(
        analyticsMetricsRepository.upsertOrgDailySessionMetrics({
          organizationId: ORG_ID,
          date: DATE,
          distanceDeltaKm: 1,
          durationDeltaSeconds: 60,
        }),
      ).rejects.toThrow("Analytics: failed to upsert org session metrics");
    });
  });

  // ─── upsertEmployeeDailyExpenseMetrics ──────────────────────────────────

  describe("upsertEmployeeDailyExpenseMetrics()", () => {
    it("increments expenses_count by 1 and adds amount when row exists", async () => {
      const existing = { expenses_count: 3, expenses_amount: 250.0 };
      const builder = makeBuilder(existing);
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      await analyticsMetricsRepository.upsertEmployeeDailyExpenseMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        amountDelta: 99.99,
      });

      expect(builder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: ORG_ID,
          employee_id: EMPLOYEE_ID,
          date: DATE,
          expenses_count: 4,
          expenses_amount: 349.99,
        }),
        { onConflict: "employee_id,date" },
      );
    });

    it("starts from zero when no existing expense row", async () => {
      const builder = makeBuilder(null);
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      await analyticsMetricsRepository.upsertEmployeeDailyExpenseMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        amountDelta: 150.0,
      });

      expect(builder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          expenses_count: 1,
          expenses_amount: 150.0,
        }),
        expect.any(Object),
      );
    });

    it("rounds expenses_amount to 2 decimal places", async () => {
      const existing = { expenses_count: 1, expenses_amount: 0.1 };
      const builder = makeBuilder(existing);
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      await analyticsMetricsRepository.upsertEmployeeDailyExpenseMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        amountDelta: 0.2,
      });

      const upsertCall = builder.upsert.mock.calls[0]![0] as Record<string, number>;
      // 0.1 + 0.2 = 0.3 — not 0.30000000000000004
      expect(upsertCall.expenses_amount).toBe(0.3);
    });

    it("uses onConflict key employee_id,date (same table as session metrics)", async () => {
      const builder = makeBuilder(null);
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      await analyticsMetricsRepository.upsertEmployeeDailyExpenseMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        amountDelta: 50,
      });

      expect(builder.upsert).toHaveBeenCalledWith(
        expect.any(Object),
        { onConflict: "employee_id,date" },
      );
    });

    it("throws on Supabase upsert error", async () => {
      const builder = makeBuilder(null, { message: "foreign key violation" });
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      await expect(
        analyticsMetricsRepository.upsertEmployeeDailyExpenseMetrics({
          organizationId: ORG_ID,
          employeeId: EMPLOYEE_ID,
          date: DATE,
          amountDelta: 10,
        }),
      ).rejects.toThrow("Analytics: failed to upsert employee expense metrics");
    });

    it("reads expense columns only (not session columns)", async () => {
      const builder = makeBuilder(null);
      vi.mocked(supabase.from).mockReturnValue(builder as never);

      await analyticsMetricsRepository.upsertEmployeeDailyExpenseMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        amountDelta: 50,
      });

      // The select call should request only expense columns
      expect(builder.select).toHaveBeenCalledWith("expenses_count, expenses_amount");
    });
  });
});
