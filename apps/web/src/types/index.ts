/**
 * Re-export all shared API contract types from the single source of truth.
 * Both frontend and backend import from @fieldtrack/types so field names
 * can never drift between the two apps (the fix for BUG-04).
 */
export type {
  UserRole,
  ExpenseStatus,
  ActivityStatus,
  AttendanceSession,
  GpsLocation,
  Expense,
  OrgSummaryData,
  UserSummaryData,
  TopPerformerEntry,
  SessionTrendEntry,
  LeaderboardEntry,
  EmployeeProfileData,
  AdminSession,
  DashboardSummary,
  SuccessResponse,
  ErrorResponse,
  ApiResponse,
  PaginatedResponse,
} from "@fieldtrack/types";

export interface UserPermissions {
  viewSessions: boolean;
  viewLocations: boolean;
  viewExpenses: boolean;
  viewAnalytics: boolean;
  viewOrgSessions: boolean;
  viewOrgExpenses: boolean;
  manageExpenses: boolean;
}

export class ApiError extends Error {
  status: number;
  requestId: string;

  constructor(message: string, status: number, requestId: string = "") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.requestId = requestId;
  }
}
