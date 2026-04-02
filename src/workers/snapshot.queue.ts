/**
 * snapshot.queue.ts — BullMQ queue for feat-1 snapshot table maintenance.
 *
 * Every significant domain event (check-in, check-out, location update,
 * expense lifecycle) emits a typed job to this queue.  The snapshot worker
 * processes each job idempotently to keep the denormalised snapshot tables
 * (employee_last_state, pending_expenses, employee_metrics_snapshot,
 * active_users) up to date.
 *
 * Queue name: "snapshot-engine"
 * DLQ name:   "snapshot-failed"
 *
 * Retry policy: 5 attempts, exponential 1 s → 16 s.
 * removeOnComplete: true  (keep Redis lean)
 * removeOnFail:     false (retain for operator inspection)
 *
 * Idempotency: every job carries a stable `jobId` so BullMQ silently drops
 * duplicate enqueues.  The worker itself uses UPSERT / ON CONFLICT so
 * processing the same job twice produces the same result.
 */

import { Queue } from "bullmq";
import { getRedisConnectionOptions } from "../config/redis.js";
import { standardJobOptions } from "../lib/queue.js";

// ─── Job Payload Types ────────────────────────────────────────────────────────

export interface CheckInJobData {
  type: "CHECK_IN";
  employeeId: string;
  organizationId: string;
  sessionId: string;
  checkinAt: string;
}

export interface CheckOutJobData {
  type: "CHECK_OUT";
  employeeId: string;
  organizationId: string;
  sessionId: string;
  checkoutAt: string;
}

export interface LocationUpdateJobData {
  type: "LOCATION_UPDATE";
  employeeId: string;
  organizationId: string;
  sessionId: string;
  latitude: number;
  longitude: number;
  recordedAt: string;
}

export interface ExpenseCreatedJobData {
  type: "EXPENSE_CREATED";
  employeeId: string;
  organizationId: string;
  expenseId: string;
  amount: number;
  submittedAt: string;
}

export interface ExpenseResolvedJobData {
  type: "EXPENSE_APPROVED" | "EXPENSE_REJECTED";
  employeeId: string;
  organizationId: string;
  expenseId: string;
  amount: number;  // original amount — used to update total_expenses on APPROVED
}

export type SnapshotJobData =
  | CheckInJobData
  | CheckOutJobData
  | LocationUpdateJobData
  | ExpenseCreatedJobData
  | ExpenseResolvedJobData;

export interface SnapshotFailedJobData {
  originalData: SnapshotJobData;
  failedAt: string;
  reason: string;
}

// ─── Lazy Singletons ─────────────────────────────────────────────────────────

let _snapshotQueue: Queue<SnapshotJobData> | undefined;
let _snapshotFailedQueue: Queue<SnapshotFailedJobData, void, "dead-letter"> | undefined;

function getSnapshotQueue(): Queue<SnapshotJobData> {
  if (!_snapshotQueue) {
    _snapshotQueue = new Queue<SnapshotJobData>("snapshot-engine", {
      connection: getRedisConnectionOptions(),
      defaultJobOptions: standardJobOptions,
    });
  }
  return _snapshotQueue;
}

function getSnapshotFailedQueue(): Queue<SnapshotFailedJobData, void, "dead-letter"> {
  if (!_snapshotFailedQueue) {
    _snapshotFailedQueue = new Queue<SnapshotFailedJobData, void, "dead-letter">(
      "snapshot-failed",
      {
        connection: getRedisConnectionOptions(),
        defaultJobOptions: {
          removeOnComplete: { count: 500 },
          removeOnFail: false,
        },
      },
    );
  }
  return _snapshotFailedQueue;
}

// ─── Dead-Letter Helper ───────────────────────────────────────────────────────

export async function moveSnapshotToDeadLetter(
  jobData: SnapshotJobData,
  reason: string,
): Promise<void> {
  await getSnapshotFailedQueue().add("dead-letter", {
    originalData: jobData,
    failedAt: new Date().toISOString(),
    reason,
  });
}

// ─── Enqueue Helpers ─────────────────────────────────────────────────────────

/**
 * Deterministic jobId prevents duplicate jobs for the same logical event.
 * The snapshot worker is idempotent so even if a duplicate slips through,
 * the result is correct.
 */

export async function enqueueCheckIn(data: Omit<CheckInJobData, "type">): Promise<void> {
  const full: CheckInJobData = { type: "CHECK_IN", ...data };
  await getSnapshotQueue().add("snapshot", full, {
    jobId: `checkin:${data.sessionId}`,
  });
}

export async function enqueueCheckOut(data: Omit<CheckOutJobData, "type">): Promise<void> {
  const full: CheckOutJobData = { type: "CHECK_OUT", ...data };
  await getSnapshotQueue().add("snapshot", full, {
    jobId: `checkout:${data.sessionId}`,
  });
}

/**
 * Location updates are high-frequency — the jobId uses recordedAt so that
 * only the latest point per session-timestamp pair is kept in the queue.
 * If the same point is received twice (client retry), BullMQ deduplicates it.
 */
export async function enqueueLocationUpdate(
  data: Omit<LocationUpdateJobData, "type">,
): Promise<void> {
  const full: LocationUpdateJobData = { type: "LOCATION_UPDATE", ...data };
  await getSnapshotQueue().add("snapshot", full, {
    jobId: `loc:${data.sessionId}:${data.recordedAt}`,
  });
}

export async function enqueueExpenseCreated(
  data: Omit<ExpenseCreatedJobData, "type">,
): Promise<void> {
  const full: ExpenseCreatedJobData = { type: "EXPENSE_CREATED", ...data };
  await getSnapshotQueue().add("snapshot", full, {
    jobId: `exp-created:${data.expenseId}`,
  });
}

export async function enqueueExpenseResolved(
  data: Omit<ExpenseResolvedJobData, "type"> & {
    resolution: "EXPENSE_APPROVED" | "EXPENSE_REJECTED";
  },
): Promise<void> {
  const full: ExpenseResolvedJobData = {
    type: data.resolution,
    employeeId: data.employeeId,
    organizationId: data.organizationId,
    expenseId: data.expenseId,
    amount: data.amount,
  };
  await getSnapshotQueue().add("snapshot", full, {
    jobId: `exp-resolved:${data.expenseId}`,
  });
}
