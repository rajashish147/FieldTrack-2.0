import { z } from "zod";
import type { AttendanceSession, Expense } from "../../types/db.js";

// ─── Query Parameter Schemas ──────────────────────────────────────────────────

/**
 * Shared ISO-8601 date range parameters.
 * Both are optional; when omitted the repository applies no date filter.
 * When both are supplied the service validates that from <= to.
 */
export const dateRangeSchema = z.object({
  from: z
    .string()
    .datetime({ offset: true, message: "from must be a valid ISO-8601 date" })
    .optional(),
  to: z
    .string()
    .datetime({ offset: true, message: "to must be a valid ISO-8601 date" })
    .optional(),
});

export const orgSummaryQuerySchema = dateRangeSchema;

export const userSummaryQuerySchema = dateRangeSchema.extend({
  /** When omitted, the controller defaults to the authenticated user's own ID. */
  userId: z.string().uuid({ message: "userId must be a valid UUID" }).optional(),
});

export const ANALYTICS_METRICS = ["distance", "duration", "sessions"] as const;
export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];

/** Leaderboard supports all session metrics plus expense count ranking. */
export const LEADERBOARD_METRICS = ["distance", "duration", "sessions", "expenses"] as const;
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];

export const topPerformersQuerySchema = dateRangeSchema.extend({
  /** Defaults to "distance" when omitted. */
  metric: z.enum(ANALYTICS_METRICS, {
    error: "metric must be distance, duration, or sessions",
  }).default("distance"),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

// ─── Query Param Types ────────────────────────────────────────────────────────

export type OrgSummaryQuery = z.infer<typeof orgSummaryQuerySchema>;
export type UserSummaryQuery = z.infer<typeof userSummaryQuerySchema>;
export type TopPerformersQuery = z.infer<typeof topPerformersQuerySchema>;

// ─── Internal Repository Row Types ───────────────────────────────────────────

/**
 * Minimal row shape fetched from attendance_sessions.
 * Includes pre-computed distance and duration so the analytics service
 * can aggregate directly without a second session_summaries lookup.
 */
export type MinimalSessionRow = Pick<AttendanceSession,
  "id" | "employee_id" | "total_distance_km" | "total_duration_seconds"
>;

/**
 * Session row with an inline employee name, returned by the single-JOIN
 * query used for top performers. Avoids a second round-trip to employees.
 */
export type SessionWithEmployeeRow = MinimalSessionRow & {
  employees: { name: string } | null;
};

/**
 * Minimal row shape fetched from expenses.
 * Only amount and status needed for all analytics aggregations.
 */
export type MinimalExpenseRow = Pick<Expense,
  "amount" | "status"
>;

// ─── OpenAPI / runtime response schemas (Zod) ────────────────────────────────

export const orgSummaryResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    totalSessions: z.number(),
    totalDistanceKm: z.number(),
    totalDurationSeconds: z.number(),
    totalExpenses: z.number(),
    approvedExpenseAmount: z.number(),
    rejectedExpenseAmount: z.number(),
    activeEmployeesCount: z.number(),
  }).describe("Org-level aggregate analytics for the requested date range"),
});

export const userSummaryResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    sessionsCount: z.number(),
    totalDistanceKm: z.number(),
    totalDurationSeconds: z.number(),
    totalExpenses: z.number(),
    approvedExpenseAmount: z.number(),
    averageDistancePerSession: z.number(),
    averageSessionDurationSeconds: z.number(),
  }).describe("Per-employee aggregate analytics for the requested date range"),
});

export const topPerformersResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(z.object({
    employeeId: z.string(),
    employeeName: z.string(),
    totalDistanceKm: z.number().optional(),
    totalDurationSeconds: z.number().optional(),
    sessionsCount: z.number().optional(),
  })).describe("Ranked list of top-performing employees"),
});

export const sessionTrendResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(z.object({
    date: z.string(),
    sessions: z.number(),
    distance: z.number(),
    duration: z.number(),
  })).describe("Daily session metrics within the requested date range"),
});

export const leaderboardResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(z.object({
    rank: z.number(),
    employeeId: z.string(),
    employeeCode: z.string().nullable(),
    employeeName: z.string(),
    distance: z.number(),
    sessions: z.number(),
    duration: z.number(),
    expenses: z.number().optional(),
  })).describe("Ranked employee leaderboard for the requested metric and date range"),
});

// ─── Response Data Types ──────────────────────────────────────────────────────
// Re-exported from src/types/shared.ts — single source of truth for shared types.
// Add new response shapes to src/types/shared.ts instead.
export type {
  OrgSummaryData,
  UserSummaryData,
  TopPerformerEntry,
  SessionTrendEntry,
  LeaderboardEntry,
} from "../../types/shared.js";

// ─── Phase 20: Session Trend ─────────────────────────────────────────────────

export const sessionTrendQuerySchema = dateRangeSchema;

export type SessionTrendQuery = z.infer<typeof sessionTrendQuerySchema>;

// ─── Phase 20: Leaderboard ───────────────────────────────────────────────────

export const leaderboardQuerySchema = dateRangeSchema.extend({
  /** Defaults to "distance" when omitted. */
  metric: z.enum(LEADERBOARD_METRICS, {
    error: "metric must be distance, duration, sessions, or expenses",
  }).default("distance"),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;

