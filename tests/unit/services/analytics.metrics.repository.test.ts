import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

// Mock supabaseServiceClient before importing the repository
vi.mock("../../../src/config/supabase.js", () => {
  return {
    supabaseServiceClient: {
      from: vi.fn(),
      rpc: vi.fn(),
    },
  };
});

import { supabaseServiceClient as supabase } from "../../../src/config/supabase.js";
import { analyticsMetricsRepository } from "../../../src/modules/analytics/analytics.metrics.repository.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DATE = "2026-03-15";

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("analyticsMetricsRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all RPC calls succeed
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: null } as never);
  });

  // ─── upsertEmployeeDailySessionMetrics ──────────────────────────────────

  describe("upsertEmployeeDailySessionMetrics()", () => {
    it("calls increment_employee_session_metrics RPC with correct params", async () => {
      await analyticsMetricsRepository.upsertEmployeeDailySessionMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        distanceDeltaKm: 12.5,
        durationDeltaSeconds: 3600,
      });

      expect(supabase.rpc).toHaveBeenCalledWith("increment_employee_session_metrics", {
        p_organization_id: ORG_ID,
        p_employee_id: EMPLOYEE_ID,
        p_date: DATE,
        p_distance_km: 12.5,
        p_duration_seconds: 3600,
      });
    });

    it("passes delta values directly to RPC (DB handles atomic increments)", async () => {
      await analyticsMetricsRepository.upsertEmployeeDailySessionMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        distanceDeltaKm: 8.0,
        durationDeltaSeconds: 1800,
      });

      expect(supabase.rpc).toHaveBeenCalledWith(
        "increment_employee_session_metrics",
        expect.objectContaining({
          p_distance_km: 8.0,
          p_duration_seconds: 1800,
        }),
      );
    });

    it("passes raw distance value — DB ROUND()::float8 handles rounding", async () => {
      await analyticsMetricsRepository.upsertEmployeeDailySessionMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        distanceDeltaKm: 0.2,
        durationDeltaSeconds: 0,
      });

      // raw value forwarded; the SQL function applies ROUND(...::numeric, 3)::float8
      expect(supabase.rpc).toHaveBeenCalledWith(
        "increment_employee_session_metrics",
        expect.objectContaining({ p_distance_km: 0.2 }),
      );
    });

    it("throws on Supabase RPC error", async () => {
      vi.mocked(supabase.rpc).mockResolvedValue({
        data: null,
        error: { message: "constraint violation" },
      } as never);

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

    it("uses a single RPC call — no prior read (atomic, no TOCTOU race)", async () => {
      await analyticsMetricsRepository.upsertEmployeeDailySessionMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        distanceDeltaKm: 1,
        durationDeltaSeconds: 60,
      });

      expect(supabase.rpc).toHaveBeenCalledTimes(1);
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it("concurrent calls both invoke the RPC — DB ON CONFLICT handles atomicity", async () => {
      // With the atomic RPC approach, both calls reach the DB and the
      // ON CONFLICT DO UPDATE SET col = col + EXCLUDED.col ensures correct
      // increments without a read-then-write race window.
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

      // Both calls reached the upsert stage — DB handles the rest atomically
      expect(supabase.rpc).toHaveBeenCalledTimes(2);
    });
  });

  // ─── upsertOrgDailySessionMetrics ───────────────────────────────────────

  describe("upsertOrgDailySessionMetrics()", () => {
    it("calls increment_org_session_metrics RPC with correct params", async () => {
      await analyticsMetricsRepository.upsertOrgDailySessionMetrics({
        organizationId: ORG_ID,
        date: DATE,
        distanceDeltaKm: 15.0,
        durationDeltaSeconds: 7200,
      });

      expect(supabase.rpc).toHaveBeenCalledWith("increment_org_session_metrics", {
        p_organization_id: ORG_ID,
        p_date: DATE,
        p_distance_km: 15.0,
        p_duration_seconds: 7200,
      });
    });

    it("passes delta values directly to RPC for any starting state", async () => {
      await analyticsMetricsRepository.upsertOrgDailySessionMetrics({
        organizationId: ORG_ID,
        date: DATE,
        distanceDeltaKm: 5.0,
        durationDeltaSeconds: 900,
      });

      expect(supabase.rpc).toHaveBeenCalledWith(
        "increment_org_session_metrics",
        expect.objectContaining({
          p_distance_km: 5.0,
          p_duration_seconds: 900,
        }),
      );
    });

    it("provides org-scoped isolation via p_organization_id parameter", async () => {
      await analyticsMetricsRepository.upsertOrgDailySessionMetrics({
        organizationId: ORG_ID,
        date: DATE,
        distanceDeltaKm: 0,
        durationDeltaSeconds: 0,
      });

      expect(supabase.rpc).toHaveBeenCalledWith(
        "increment_org_session_metrics",
        expect.objectContaining({ p_organization_id: ORG_ID }),
      );
    });

    it("throws on Supabase RPC error", async () => {
      vi.mocked(supabase.rpc).mockResolvedValue({
        data: null,
        error: { message: "deadlock detected" },
      } as never);

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
    it("calls increment_employee_expense_metrics RPC with correct params", async () => {
      await analyticsMetricsRepository.upsertEmployeeDailyExpenseMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        amountDelta: 99.99,
      });

      expect(supabase.rpc).toHaveBeenCalledWith("increment_employee_expense_metrics", {
        p_organization_id: ORG_ID,
        p_employee_id: EMPLOYEE_ID,
        p_date: DATE,
        p_amount: 99.99,
      });
    });

    it("passes delta amount directly to RPC for any starting state", async () => {
      await analyticsMetricsRepository.upsertEmployeeDailyExpenseMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        amountDelta: 150.0,
      });

      expect(supabase.rpc).toHaveBeenCalledWith(
        "increment_employee_expense_metrics",
        expect.objectContaining({ p_amount: 150.0 }),
      );
    });

    it("passes raw amount — DB NUMERIC arithmetic avoids float precision drift", async () => {
      await analyticsMetricsRepository.upsertEmployeeDailyExpenseMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        amountDelta: 0.2,
      });

      // raw value forwarded; SQL NUMERIC column addition handles 0.1 + 0.2 exactly
      expect(supabase.rpc).toHaveBeenCalledWith(
        "increment_employee_expense_metrics",
        expect.objectContaining({ p_amount: 0.2 }),
      );
    });

    it("uses a single RPC call — no prior read (atomic, no TOCTOU race)", async () => {
      await analyticsMetricsRepository.upsertEmployeeDailyExpenseMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        amountDelta: 50,
      });

      expect(supabase.rpc).toHaveBeenCalledTimes(1);
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it("throws on Supabase RPC error", async () => {
      vi.mocked(supabase.rpc).mockResolvedValue({
        data: null,
        error: { message: "foreign key violation" },
      } as never);

      await expect(
        analyticsMetricsRepository.upsertEmployeeDailyExpenseMetrics({
          organizationId: ORG_ID,
          employeeId: EMPLOYEE_ID,
          date: DATE,
          amountDelta: 10,
        }),
      ).rejects.toThrow("Analytics: failed to upsert employee expense metrics");
    });

    it("provides employee-scoped isolation via p_employee_id parameter", async () => {
      await analyticsMetricsRepository.upsertEmployeeDailyExpenseMetrics({
        organizationId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        date: DATE,
        amountDelta: 50,
      });

      expect(supabase.rpc).toHaveBeenCalledWith(
        "increment_employee_expense_metrics",
        expect.objectContaining({ p_employee_id: EMPLOYEE_ID }),
      );
    });
  });
});
