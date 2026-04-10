/**
 * @fieldtrack/types — shared API contract types
 *
 * These interfaces define the exact shapes returned by the FieldTrack API.
 * Both the backend (response serialization) and the frontend (hook types,
 * component props) import from here so a single change keeps both in sync.
 *
 * Rules:
 *   - Interfaces must mirror actual DB column names and nullability.
 *   - No runtime code — this package is pure type declarations.
 *   - `distance_recalculation_status` is intentionally typed `string`; the
 *     frontend has no reason to switch on the specific enum values.
 */

// ─── Enums ────────────────────────────────────────────────────────────────────

export type UserRole = "ADMIN" | "EMPLOYEE";
export type ExpenseStatus = "PENDING" | "APPROVED" | "REJECTED";
export type ActivityStatus = "ACTIVE" | "RECENT" | "INACTIVE";

// ─── Database row shapes (API response payloads) ──────────────────────────────

export interface AttendanceSession {
  id: string;
  employee_id: string;
  organization_id: string;
  checkin_at: string;
  checkout_at: string | null;
  total_distance_km: number | null;
  total_duration_seconds: number | null;
  distance_recalculation_status: string | null;
  created_at: string;
  updated_at: string;
  /** Joined from employees table — present on all enriched queries */
  employee_code?: string | null;
  /** Populated only for org-wide admin queries (joined from employees table) */
  employee_name?: string | null;
  /** Computed activity classification based on checkout_at timestamp */
  activityStatus?: ActivityStatus;
}

/**
 * Explicit DTO for session list API responses.
 *
 * Unlike AttendanceSession (which mirrors the DB row), every field here is
 * required — the mapper function is responsible for resolving nulls and
 * computing derived fields. This prevents database schema from leaking
 * directly to the API and guards against future schema drift.
 *
 * Produced by: mapLatestSessionRow()  (snapshot path)
 *              findSessionsByUser()   (attendance_sessions path)
 */
export interface SessionDTO {
  id: string | null;
  employee_id: string;
  organization_id: string;
  checkin_at: string;
  checkout_at: string | null;
  total_distance_km: number | null;
  total_duration_seconds: number | null;
  distance_recalculation_status: string | null;
  created_at: string;
  updated_at: string;
  employee_code: string | null;
  employee_name: string | null;
  activityStatus: ActivityStatus;
}

export interface GpsLocation {
  id: string;
  session_id: string;
  employee_id: string;
  organization_id: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  recorded_at: string;
  sequence_number: number | null;
  is_duplicate: boolean;
}

export interface Expense {
  id: string;
  employee_id: string;
  organization_id: string;
  amount: number;
  description: string;
  receipt_url: string | null;
  status: ExpenseStatus;
  rejection_comment: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
  updated_at: string;
  /** Joined from employees table */
  employee_code?: string | null;
  employee_name?: string | null;
}

// ─── Analytics API response shapes ───────────────────────────────────────────

export interface OrgSummaryData {
  totalSessions: number;
  totalDistanceKm: number;
  totalDurationSeconds: number;
  totalExpenses: number;
  approvedExpenseAmount: number;
  rejectedExpenseAmount: number;
  activeEmployeesCount: number;
}

export interface UserSummaryData {
  sessionsCount: number;
  totalDistanceKm: number;
  totalDurationSeconds: number;
  totalExpenses: number;
  approvedExpenseAmount: number;
  averageDistancePerSession: number;
  averageSessionDurationSeconds: number;
}

export interface TopPerformerEntry {
  employeeId: string;
  employeeName: string;
  totalDistanceKm?: number;
  totalDurationSeconds?: number;
  sessionsCount?: number;
}

// ─── Analytics Engine (Phase 20) ──────────────────────────────────────────────

export interface SessionTrendEntry {
  date: string;
  sessions: number;
  distance: number;
  duration: number;
}

export interface LeaderboardEntry {
  rank: number;
  employeeId: string;
  employeeCode: string | null;
  employeeName: string;
  distance: number;
  sessions: number;
  duration: number;
  /** Populated only when the leaderboard is ranked by the "expenses" metric. */
  expenses?: number;
}

export interface EmployeeProfileData {
  id: string;
  name: string;
  employee_code: string | null;
  phone: string | null;
  is_active: boolean;
  activityStatus: ActivityStatus;
  last_activity_at: string | null;
  created_at: string;
  stats: {
    totalSessions: number;
    totalDistanceKm: number;
    totalDurationSeconds: number;
    expensesSubmitted: number;
    expensesApproved: number;
  };
}

// ─── Admin monitoring ──────────────────────────────────────────────────────────────

export interface AdminSession {
  id: string;
  admin_id: string;
  organization_id: string;
  started_at: string;
  ended_at: string | null;
  created_at: string;
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────────

export interface DashboardSummary {
  sessionsThisWeek: number;
  distanceThisWeek: number;
  hoursThisWeek: number;
  expensesSubmitted: number;
  expensesApproved: number;
}

// ─── Admin aggregations ───────────────────────────────────────────────────────

/** One row per employee — pending expense summary for the admin expenses page. */
export interface EmployeeExpenseSummary {
  employeeId: string;
  employeeName: string;
  employeeCode: string | null;
  pendingCount: number;
  pendingAmount: number;
  totalCount: number;
  totalAmount: number;
  latestExpenseDate: string | null;
}

/** Aggregated dashboard data — returned by GET /admin/dashboard. */
export interface AdminDashboardData {
  activeEmployeeCount: number;
  recentEmployeeCount: number;
  inactiveEmployeeCount: number;
  /** Employees with an open session right now (from employee_latest_sessions snapshot). */
  activeEmployeesToday: number;
  todaySessionCount: number;
  todayDistanceKm: number;
  pendingExpenseCount: number;
  pendingExpenseAmount: number;
  /** Daily session trend for the last 7 days (from org_daily_metrics). */
  sessionTrend: SessionTrendEntry[];
  /** Top-5 employees ranked by distance over the last 30 days (from employee_daily_metrics). */
  leaderboard: LeaderboardEntry[];
  /**
   * ISO-8601 timestamp of the most recent snapshot update (org_dashboard_snapshot.updated_at).
   * Use to display "Last updated X seconds ago" in the UI for eventual consistency transparency.
   * Null when the snapshot has never been written for this org.
   */
  snapshotUpdatedAt: string | null;
}

/**
 * Map marker entry — returned by GET /admin/monitoring/map.
 * One row per employee that has at least one recorded GPS point.
 * `latitude` / `longitude` are the most recent GPS fix for the employee.
 */
export interface EmployeeMapMarker {
  employeeId: string;
  employeeName: string;
  employeeCode: string | null;
  status: ActivityStatus;
  sessionId: string | null;
  latitude: number;
  longitude: number;
  recordedAt: string;
}

// ─── Generic API response wrappers ───────────────────────────────────────────

export interface SuccessResponse<T> {
  success: true;
  data: T;
}

export interface ErrorResponse {
  success: false;
  error: string;
  requestId: string;
}

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;

export interface PaginatedResponse<T> {
  success: true;
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
  };
}
