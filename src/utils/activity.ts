/**
 * activity.ts — Single source of truth for ActivityStatus computation.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  ACTIVITY MODEL: SNAPSHOT-BASED (EVENTUAL CONSISTENCY)                  │
 * │                                                                         │
 * │  Activity status is derived from the `employee_last_state` snapshot     │
 * │  table, NOT from raw attendance_sessions or gps_locations.              │
 * │                                                                         │
 * │  The snapshot is updated asynchronously by the snapshot worker after    │
 * │  each check-in/check-out event. This means:                            │
 * │    - Status may lag real-time by a few seconds (P99 < 5s)              │
 * │    - The reconciliation job runs every 5 minutes as a safety net       │
 * │    - If snapshots are stale > 10 min, /internal/snapshot-health        │
 * │      returns "degraded" (503)                                          │
 * │                                                                         │
 * │  DEVELOPER GUARDRAILS:                                                  │
 * │    ❌ DO NOT compute activity status from raw attendance_sessions       │
 * │    ❌ DO NOT query checkout_at directly for admin-facing status         │
 * │    ✅ ALWAYS use computeActivityStatus() from this module               │
 * │    ✅ ALWAYS rely on employee_last_state for admin queries              │
 * │    ✅ Use computeActivityStatusFromSession() ONLY for session row       │
 * │       mapping within the attendance repository                          │
 * │                                                                         │
 * │  SEGMENT DEFINITIONS:                                                   │
 * │    ACTIVE   → employee_last_state.is_checked_in = true                 │
 * │    RECENT   → is_checked_in = false AND last_check_out_at >= now()-24h │
 * │    INACTIVE → NOT (ACTIVE OR RECENT), includes no-snapshot employees   │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * All activity status decisions in the backend MUST go through this function.
 * The authoritative data source is `employee_last_state` (is_checked_in +
 * last_check_out_at), not attendance_sessions.checkout_at.
 *
 * Logic matches the DB-side CASE expression in reconcile_snapshot_tables():
 *   WHEN is_checked_in = true              → 'ACTIVE'
 *   WHEN last_check_out_at >= now() - 24h  → 'RECENT'
 *   ELSE                                   → 'INACTIVE'
 */

import type { ActivityStatus } from "../types/shared.js";

/** 24 hours in milliseconds — matches the snapshot worker and reconciliation job. */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Compute ActivityStatus from employee_last_state fields.
 *
 * @param isCheckedIn     Value of employee_last_state.is_checked_in
 * @param lastCheckOutAt  Value of employee_last_state.last_check_out_at (ISO string or null)
 */
export function computeActivityStatus(
  isCheckedIn: boolean,
  lastCheckOutAt: string | null,
): ActivityStatus {
  if (isCheckedIn) return "ACTIVE";
  if (lastCheckOutAt !== null) {
    const ageMs = Date.now() - new Date(lastCheckOutAt).getTime();
    if (ageMs < RECENT_WINDOW_MS) return "RECENT";
  }
  return "INACTIVE";
}

/**
 * Convenience overload for attendance_sessions rows where checkout_at = null
 * implies the employee is still checked in (no employee_last_state join).
 *
 * Use this ONLY in the attendance repository for session-row mapping.
 * All admin-facing queries must use `computeActivityStatus` above.
 */
export function computeActivityStatusFromSession(
  checkoutAt: string | null,
): ActivityStatus {
  if (checkoutAt === null) return "ACTIVE";
  const ageMs = Date.now() - new Date(checkoutAt).getTime();
  return ageMs < RECENT_WINDOW_MS ? "RECENT" : "INACTIVE";
}
