/**
 * Date-range utilities for FieldTrack analytics.
 *
 * All helpers return ISO-8601 strings that satisfy the API's dateRangeSchema
 * (full datetime with offset, e.g. "2026-03-14T00:00:00.000Z").
 *
 * Dates are computed in the browser's local timezone so that "today" means
 * the calendar day the user experiences, regardless of server timezone.
 *
 * ── UTC Server Policy ─────────────────────────────────────────────────────────
 * The FieldTrack API stores all timestamps in UTC and aggregates daily metrics
 * using UTC midnight boundaries. When the frontend sends `from`/`to` strings
 * the API strips them to YYYY-MM-DD (UTC date) before querying daily_metrics.
 * For global orgs operating across multiple timezones this means the "week"
 * and "month" boundaries seen by the API may differ by up to ±14 hours from
 * the local-timezone boundaries used here. This is an acceptable trade-off
 * for the current use-case; per-org timezone support is tracked separately.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DateRange {
  from: string; // ISO-8601 datetime string
  to: string;   // ISO-8601 datetime string
}

export type PresetKey =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "thisMonth"
  | "lastMonth"
  | "custom";

export const PRESET_LABELS: Record<PresetKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  thisMonth: "This Month",
  lastMonth: "Last Month",
  custom: "Custom",
};

// ─── Range builders ───────────────────────────────────────────────────────────

/** Today: 00:00:00 local → now */
export function todayRange(): DateRange {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  return { from: start.toISOString(), to: now.toISOString() };
}

/** Yesterday: 00:00:00 → 23:59:59 local */
export function yesterdayRange(): DateRange {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Last N calendar days starting at 00:00 day-(n-1) → now */
export function lastNDaysRange(n: number): DateRange {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1), 0, 0, 0, 0);
  return { from: start.toISOString(), to: now.toISOString() };
}

/** From the 1st of the current month 00:00 → now */
export function thisMonthRange(): DateRange {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  return { from: start.toISOString(), to: now.toISOString() };
}

/** Entire previous calendar month */
export function lastMonthRange(): DateRange {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

/**
 * Current ISO week: Monday 00:00 → now (local timezone).
 * ISO week starts on Monday (day 1). If today is Sunday (day 0), we look back 6 days.
 * Mirrors the backend's getWeekStartDate() UTC Monday so analytics numbers
 * are consistent when the browser and server are in similar timezones.
 */
export function thisWeekRange(): DateRange {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysFromMonday, 0, 0, 0, 0);
  return { from: monday.toISOString(), to: now.toISOString() };
}

/** Resolve a named preset to a concrete DateRange. */
export function rangeForPreset(preset: Exclude<PresetKey, "custom">): DateRange {
  switch (preset) {
    case "today":     return todayRange();
    case "yesterday": return yesterdayRange();
    case "7d":        return lastNDaysRange(7);
    case "30d":       return lastNDaysRange(30);
    case "thisMonth": return thisMonthRange();
    case "lastMonth": return lastMonthRange();
  }
}

// ─── HTML date-input helpers ──────────────────────────────────────────────────

/** Format a Date as YYYY-MM-DD for use with <input type="date"> */
export function toInputDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Human-readable summary of a DateRange, e.g. "14 Mar – 14 Mar 2026" */
export function formatRangeLabel(range: DateRange): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  const from = fmt(range.from);
  const to = fmt(range.to);
  return from === to ? from : `${from} – ${to}`;
}

// ─── localStorage persistence ─────────────────────────────────────────────────

const LS_PRESET = "fieldtrack_analytics_preset";
const LS_CUSTOM = "fieldtrack_analytics_custom";

export function loadPersistedPreset(): PresetKey {
  if (typeof window === "undefined") return "7d";
  const v = localStorage.getItem(LS_PRESET);
  if (v && v in PRESET_LABELS) return v as PresetKey;
  return "7d";
}

export function loadPersistedCustomRange(): DateRange | null {
  if (typeof window === "undefined") return null;
  const v = localStorage.getItem(LS_CUSTOM);
  if (!v) return null;
  try {
    return JSON.parse(v) as DateRange;
  } catch {
    return null;
  }
}

export function persistPreset(preset: PresetKey): void {
  if (typeof window !== "undefined") localStorage.setItem(LS_PRESET, preset);
}

export function persistCustomRange(range: DateRange): void {
  if (typeof window !== "undefined")
    localStorage.setItem(LS_CUSTOM, JSON.stringify(range));
}
