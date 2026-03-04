import { z } from "zod";

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
 * Minimal row shape fetched from session_summaries.
 * Only the fields needed for aggregation are selected — never select("*").
 */
export interface MinimalSummaryRow {
  user_id: string;
  total_distance_meters: number;
  duration_seconds: number;
}

/**
 * Minimal row shape fetched from attendance_sessions.
 * Used only to resolve session IDs for a given date range.
 */
export interface MinimalSessionRow {
  id: string;
  user_id: string;
}

/**
 * Minimal row shape fetched from expenses.
 * Only amount and status needed for all analytics aggregations.
 */
export interface MinimalExpenseRow {
  amount: number;
  status: string;
}

// ─── Response Data Types ──────────────────────────────────────────────────────

export interface OrgSummaryData {
  totalSessions: number;
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  totalExpenses: number;
  approvedExpenseAmount: number;
  rejectedExpenseAmount: number;
  activeUsersCount: number;
}

export interface UserSummaryData {
  sessionsCount: number;
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  totalExpenses: number;
  approvedExpenseAmount: number;
  averageDistancePerSession: number;
  averageSessionDurationSeconds: number;
}

export interface TopPerformerEntry {
  userId: string;
  totalDistanceMeters?: number;
  totalDurationSeconds?: number;
  sessionsCount?: number;
}
