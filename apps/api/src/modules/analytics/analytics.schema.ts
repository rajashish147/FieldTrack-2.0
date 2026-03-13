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
  userId: z.string().uuid({ message: "userId must be a valid UUID" }),
});

export const ANALYTICS_METRICS = ["distance", "duration", "sessions"] as const;
export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];

/** Leaderboard supports all session metrics plus expense count ranking. */
export const LEADERBOARD_METRICS = ["distance", "duration", "sessions", "expenses"] as const;
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];

export const topPerformersQuerySchema = dateRangeSchema.extend({
  metric: z.enum(ANALYTICS_METRICS, {
    error: "metric must be distance, duration, or sessions",
  }),
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

// ─── Response Data Types ──────────────────────────────────────────────────────
// Re-exported from @fieldtrack/types — single source of truth shared with the
// frontend. Add new response shapes to packages/types/src/index.ts instead.
export type {
  OrgSummaryData,
  UserSummaryData,
  TopPerformerEntry,
  SessionTrendEntry,
  LeaderboardEntry,
} from "@fieldtrack/types";

// ─── Phase 20: Session Trend ─────────────────────────────────────────────────

export const sessionTrendQuerySchema = dateRangeSchema;

export type SessionTrendQuery = z.infer<typeof sessionTrendQuerySchema>;

// ─── Phase 20: Leaderboard ───────────────────────────────────────────────────

export const leaderboardQuerySchema = dateRangeSchema.extend({
  metric: z.enum(LEADERBOARD_METRICS, {
    error: "metric must be distance, duration, sessions, or expenses",
  }),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;

