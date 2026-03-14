/**
 * Centralised API endpoint paths.
 * All query hooks must import paths from here instead of inlining strings.
 */
export const API = {
  // Sessions (attendance)
  sessions: "/attendance/my-sessions",
  orgSessions: "/attendance/org-sessions",
  /** Snapshot-backed endpoint — one row per employee, O(employees) read. */
  adminSessions: "/admin/sessions",

  // Locations (GPS route)
  route: "/locations/my-route",

  // Expenses
  expenses: "/expenses/my",
  orgExpenses: "/admin/expenses",
  expenseStatus: (id: string) => `/admin/expenses/${id}`,
  createExpense: "/expenses",

  // Analytics
  orgSummary: "/admin/org-summary",
  topPerformers: "/admin/top-performers",
  sessionTrend: "/admin/session-trend",
  leaderboard: "/leaderboard",

  // Personal dashboard
  myDashboard: "/dashboard/my-summary",

  // Admin monitoring
  startMonitoring: "/admin/start-monitoring",
  stopMonitoring: "/admin/stop-monitoring",
  monitoringHistory: "/admin/monitoring-history",

  // Employee management
  createEmployee: "/admin/employees",

  // Profile
  myProfile: "/profile/me",
  employeeProfile: (id: string) => `/admin/employees/${id}/profile`,

  // Admin aggregations
  /** Expense totals grouped by employee — one row per employee. */
  expensesSummary: "/admin/expenses/summary",
  /** Single-request dashboard aggregation replacing 4+ separate calls. */
  adminDashboard: "/admin/dashboard",
  /** Latest GPS position per employee for map rendering. */
  adminMap: "/admin/monitoring/map",
} as const;
