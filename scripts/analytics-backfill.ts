/**
 * analytics-backfill.ts — Phase 21 backfill script.
 *
 * Scans historical attendance_sessions and populates employee_daily_metrics
 * and org_daily_metrics for any dates that have missing or incomplete rows.
 *
 * Usage:
 *   npm run analytics:backfill
 *
 * The script is additive and idempotent: running it multiple times produces
 * the same result.  Existing rows are updated via UPSERT (SET, not increment),
 * so it is safe to re-run after data corrections.
 *
 * Processing:
 *  - Fetches all completed sessions (checkout_at IS NOT NULL AND
 *    total_distance_km IS NOT NULL) in batches of BATCH_SIZE.
 *  - Groups by (organization_id, employee_id, date).
 *  - UPSERTs employee_daily_metrics for each group.
 *  - UPSERTs org_daily_metrics by aggregating the just-written employee rows.
 *
 * Skips sessions where total_distance_km is NULL (distance worker not yet run).
 */

import dotenv from "dotenv";
dotenv.config();

import { createClient } from "@supabase/supabase-js";

// ─── Configuration ────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env["SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/** Number of sessions fetched per paginated round-trip. */
const BATCH_SIZE = 500;

/** Pause between batches to avoid overwhelming the DB connection pool. */
const BATCH_DELAY_MS = 100;

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  employee_id: string;
  organization_id: string;
  checkin_at: string;
  total_distance_km: number;
  total_duration_seconds: number;
}

interface DailyKey {
  orgId: string;
  empId: string;
  date: string;
}

interface DailyAggregate {
  sessions: number;
  distance_km: number;
  duration_seconds: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Group session rows by (organization_id, employee_id, date) and accumulate
 * totals.  Returns a map keyed by `orgId|empId|date`.
 */
function groupByEmployeeDay(
  sessions: SessionRow[],
): Map<string, { key: DailyKey; agg: DailyAggregate }> {
  const map = new Map<string, { key: DailyKey; agg: DailyAggregate }>();

  for (const s of sessions) {
    const date = s.checkin_at.substring(0, 10);
    const mapKey = `${s.organization_id}|${s.employee_id}|${date}`;
    const existing = map.get(mapKey);
    if (existing) {
      existing.agg.sessions++;
      existing.agg.distance_km += s.total_distance_km ?? 0;
      existing.agg.duration_seconds += s.total_duration_seconds ?? 0;
    } else {
      map.set(mapKey, {
        key: { orgId: s.organization_id, empId: s.employee_id, date },
        agg: {
          sessions: 1,
          distance_km: s.total_distance_km ?? 0,
          duration_seconds: s.total_duration_seconds ?? 0,
        },
      });
    }
  }

  return map;
}

// ─── Backfill Logic ───────────────────────────────────────────────────────────

async function backfill(): Promise<void> {
  console.log("=== FieldTrack Analytics Backfill ===");
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log("Fetching completed, distance-computed sessions...\n");

  let page = 0;
  let totalSessions = 0;
  let totalEmployeeDays = 0;
  let totalErrors = 0;
  let hasMore = true;

  while (hasMore) {
    const from = page * BATCH_SIZE;
    const to = from + BATCH_SIZE - 1;

    const { data, error } = await supabase
      .from("attendance_sessions")
      .select(
        "id, employee_id, organization_id, checkin_at, total_distance_km, total_duration_seconds",
      )
      .not("checkout_at", "is", null)
      .not("total_distance_km", "is", null)
      .order("checkin_at", { ascending: true })
      .range(from, to);

    if (error) {
      console.error(`Batch ${page + 1}: fetch error — ${error.message}`);
      totalErrors++;
      break;
    }

    const batch = (data ?? []) as SessionRow[];
    if (batch.length === 0) {
      break;
    }

    console.log(
      `Batch ${page + 1}: processing ${batch.length} sessions (offset ${from})...`,
    );

    // ── Group sessions by (org, employee, date) ───────────────────────────────

    const employeeDayMap = groupByEmployeeDay(batch);
    totalSessions += batch.length;
    totalEmployeeDays += employeeDayMap.size;

    // ── UPSERT employee_daily_metrics ─────────────────────────────────────────

    const empUpsertRows = [...employeeDayMap.values()].map(({ key, agg }) => ({
      organization_id: key.orgId,
      employee_id: key.empId,
      date: key.date,
      sessions: agg.sessions,
      distance_km: Math.round(agg.distance_km * 1000) / 1000,
      duration_seconds: agg.duration_seconds,
    }));

    const { error: empErr } = await supabase
      .from("employee_daily_metrics")
      .upsert(empUpsertRows, { onConflict: "employee_id,date" });

    if (empErr) {
      console.error(`  employee_daily_metrics upsert failed: ${empErr.message}`);
      totalErrors++;
    } else {
      console.log(`  employee_daily_metrics: upserted ${empUpsertRows.length} rows`);
    }

    // ── Compute org-level aggregates from the employee rows we just wrote ─────

    // Group the same batch by (org, date)
    const orgDayMap = new Map<string, { orgId: string; date: string; agg: DailyAggregate }>();
    for (const { key, agg } of employeeDayMap.values()) {
      const mapKey = `${key.orgId}|${key.date}`;
      const existing = orgDayMap.get(mapKey);
      if (existing) {
        existing.agg.sessions += agg.sessions;
        existing.agg.distance_km += agg.distance_km;
        existing.agg.duration_seconds += agg.duration_seconds;
      } else {
        orgDayMap.set(mapKey, {
          orgId: key.orgId,
          date: key.date,
          agg: { ...agg },
        });
      }
    }

    const orgUpsertRows = [...orgDayMap.values()].map(({ orgId, date, agg }) => ({
      organization_id: orgId,
      date,
      total_sessions: agg.sessions,
      total_distance_km: Math.round(agg.distance_km * 1000) / 1000,
      total_duration_seconds: agg.duration_seconds,
    }));

    const { error: orgErr } = await supabase
      .from("org_daily_metrics")
      .upsert(orgUpsertRows, { onConflict: "organization_id,date" });

    if (orgErr) {
      console.error(`  org_daily_metrics upsert failed: ${orgErr.message}`);
      totalErrors++;
    } else {
      console.log(`  org_daily_metrics: upserted ${orgUpsertRows.length} rows`);
    }

    if (batch.length < BATCH_SIZE) {
      // Last page — no more rows
      hasMore = false;
    } else {
      page++;
      await sleep(BATCH_DELAY_MS);
    }
  }

  console.log("\n=== Backfill Complete ===");
  console.log(`Sessions processed : ${totalSessions}`);
  console.log(`Employee-day rows  : ${totalEmployeeDays}`);
  console.log(`Errors             : ${totalErrors}`);

  if (totalErrors > 0) {
    console.error("Backfill completed with errors — check output above.");
    process.exit(1);
  }
}

backfill().catch((err: unknown) => {
  console.error("Backfill failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
