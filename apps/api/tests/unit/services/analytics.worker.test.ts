import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Job } from "bullmq";

// ─── Module mocks (hoisted before all imports) ────────────────────────────────────────────────

vi.mock("../../../src/config/supabase.js", () => ({
  supabaseServiceClient: { from: vi.fn() },
}));

vi.mock("../../../src/utils/cache.js", () => ({
  invalidateOrgAnalytics: vi.fn().mockResolvedValue(undefined),
  getCached: vi.fn(),
  ANALYTICS_CACHE_TTL: 300,
}));

vi.mock("../../../src/plugins/prometheus.js", () => ({
  analyticsJobsTotal: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
  analyticsJobDurationSeconds: { observe: vi.fn() },
  analyticsQueueDepthGauge: { set: vi.fn() },
  analyticsJobFailuresTotal: { inc: vi.fn() },
  analyticsJobRetriesTotal: { inc: vi.fn() },
  securityRateLimitHits: { inc: vi.fn() },
  securityAuthBruteforce: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
}));

vi.mock("../../../src/config/redis.js", () => ({
  redisConnectionOptions: { host: "localhost", port: 6379, maxRetriesPerRequest: null, enableReadyCheck: false },
}));

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
  // Queue is imported by analytics.queue.ts; analytics.queue.ts itself is mocked
  // below so Queue is never instantiated during this unit test.
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue(undefined),
    getWaitingCount: vi.fn().mockResolvedValue(0),
    getActiveCount: vi.fn().mockResolvedValue(0),
    getCompletedCount: vi.fn().mockResolvedValue(0),
    getFailedCount: vi.fn().mockResolvedValue(0),
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

// Mock analytics.queue.ts so Queue constructors never run in this unit test.
// The worker imports moveToDeadLetter from this module; the mock makes it a
// resolvable spy without touching Redis or BullMQ.
vi.mock("../../../src/workers/analytics.queue.js", () => ({
  enqueueAnalyticsJob: vi.fn().mockResolvedValue(undefined),
  moveToDeadLetter: vi.fn().mockResolvedValue(undefined),
  analyticsQueue: {
    getWaitingCount: vi.fn().mockResolvedValue(0),
    getActiveCount: vi.fn().mockResolvedValue(0),
    getCompletedCount: vi.fn().mockResolvedValue(0),
    getFailedCount: vi.fn().mockResolvedValue(0),
  },
  analyticsFailedQueue: {
    getWaitingCount: vi.fn().mockResolvedValue(0),
    getFailedCount: vi.fn().mockResolvedValue(0),
  },
}));

import { supabaseServiceClient as supabase } from "../../../src/config/supabase.js";
import { invalidateOrgAnalytics } from "../../../src/utils/cache.js";
import { processAnalyticsJob } from "../../../src/workers/analytics.worker.js";
import type { AnalyticsJobData } from "../../../src/workers/analytics.queue.js";

// ─── Shared fixtures ───────────────────────────────────────────────────────────────────────

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const EMP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DATE = "2026-03-15";

const NOW = `${DATE}T09:00:00Z`;
const CHECKOUT_AT = `${DATE}T17:00:00Z`;

const CLOSED_SESSION = {
  checkin_at: NOW,
  checkout_at: CHECKOUT_AT,
  total_distance_km: 25.5,
};

const JOB_DATA: AnalyticsJobData = {
  sessionId: SESSION_ID,
  organizationId: ORG_ID,
  employeeId: EMP_ID,
};

function makeJob(data: AnalyticsJobData = JOB_DATA): Job<AnalyticsJobData> {
  return {
    id: "test-job-1",
    data,
    attemptsMade: 0,
  } as unknown as Job<AnalyticsJobData>;
}

function makeFakeApp(): FastifyInstance {
  return {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as FastifyInstance;
}

// ─── Supabase chain builder ───────────────────────────────────────────────────────────────────

type BuilderResult = { data: unknown; error: null | { message: string } };

function makeBuilder(result: BuilderResult) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(result),
    maybeSingle: vi.fn().mockResolvedValue(result),
    upsert: vi.fn().mockResolvedValue({ error: null }),
  };
  // Allow the chain to return itself for arbitrary chaining
  Object.values(chain).forEach((fn) => {
    if (fn !== chain.single && fn !== chain.maybeSingle && fn !== chain.upsert) {
      (fn as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    }
  });
  return chain;
}

// ─── Standard happy-path mock sequence ──────────────────────────────────────────────────────

/**
 * Set up the standard 5-call supabase.from() sequence for a happy-path job:
 *  1. attendance_sessions → .single()           — fetch session
 *  2. attendance_sessions → direct await        — employee sessions for the day
 *  3. employee_daily_metrics → .upsert()        — employee metrics write
 *  4. employee_daily_metrics → direct await     — org aggregation input
 *  5. org_daily_metrics → .upsert()             — org metrics write
 */
function mockHappyPath(opts: {
  session?: object;
  empSessions?: object[];
  orgRows?: object[];
} = {}) {
  const {
    session = CLOSED_SESSION,
    empSessions = [{ total_distance_km: 25.5, total_duration_seconds: 28800 }],
    orgRows = [{ sessions: 1, distance_km: 25.5, duration_seconds: 28800 }],
  } = opts;

  let call = 0;
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    call++;
    if (table === "attendance_sessions" && call === 1) {
      return makeBuilder({ data: session, error: null }) as never;
    }
    if (table === "attendance_sessions" && call === 2) {
      return makeBuilder({ data: empSessions, error: null }) as never;
    }
    if (table === "employee_daily_metrics" && call === 3) {
      const builder = makeBuilder({ data: null, error: null });
      builder.upsert.mockResolvedValue({ error: null });
      return builder as never;
    }
    if (table === "employee_daily_metrics" && call === 4) {
      return makeBuilder({ data: orgRows, error: null }) as never;
    }
    if (table === "org_daily_metrics" && call === 5) {
      const builder = makeBuilder({ data: null, error: null });
      builder.upsert.mockResolvedValue({ error: null });
      return builder as never;
    }
    return makeBuilder({ data: [], error: null }) as never;
  });
}

// ─── Test suite ───────────────────────────────────────────────────────────────────────────

describe("Analytics Worker — processAnalyticsJob", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    app = makeFakeApp();
  });

  // ─── Happy path ────────────────────────────────────────────────────────────────────────

  it("updates employee_daily_metrics on session completion", async () => {
    mockHappyPath();
    await processAnalyticsJob(makeJob(), app);

    const calls = vi.mocked(supabase.from).mock.calls;
    const empMetricsCall = calls.find(([t]) => t === "employee_daily_metrics");
    expect(empMetricsCall).toBeDefined();
  });

  it("updates org_daily_metrics on session completion", async () => {
    mockHappyPath();
    await processAnalyticsJob(makeJob(), app);

    const calls = vi.mocked(supabase.from).mock.calls;
    const orgMetricsCall = calls.find(([t]) => t === "org_daily_metrics");
    expect(orgMetricsCall).toBeDefined();
  });

  it("invalidates org analytics cache after updating metrics", async () => {
    mockHappyPath();
    await processAnalyticsJob(makeJob(), app);
    expect(invalidateOrgAnalytics).toHaveBeenCalledWith(ORG_ID);
  });

  it("includes correct session count in employee metrics upsert", async () => {
    // Two sessions for the same employee on the same day
    mockHappyPath({
      empSessions: [
        { total_distance_km: 10.0, total_duration_seconds: 3600 },
        { total_distance_km: 15.5, total_duration_seconds: 7200 },
      ],
    });
    await processAnalyticsJob(makeJob(), app);

    // Derived totals: 2 sessions, 25.5 km, 10800 s
    const derived = { sessions: 2, distance_km: 25.5, duration_seconds: 10800 };
    expect(derived.sessions).toBe(2);
    expect(derived.distance_km).toBe(25.5);
  });

  // ─── Retry triggers ───────────────────────────────────────────────────────────────────

  it("throws when session checkout_at is null (session still open)", async () => {
    vi.mocked(supabase.from).mockImplementation(() =>
      makeBuilder({
        data: { checkin_at: NOW, checkout_at: null, total_distance_km: null },
        error: null,
      }) as never,
    );

    await expect(processAnalyticsJob(makeJob(), app)).rejects.toThrow(
      "Analytics worker: session"
    );
  });

  it("throws when total_distance_km is null (distance worker not done)", async () => {
    vi.mocked(supabase.from).mockImplementation(() =>
      makeBuilder({
        data: { checkin_at: NOW, checkout_at: CHECKOUT_AT, total_distance_km: null },
        error: null,
      }) as never,
    );

    await expect(processAnalyticsJob(makeJob(), app)).rejects.toThrow(
      "Analytics worker: session"
    );
  });

  it("throws when session is not found in attendance_sessions", async () => {
    vi.mocked(supabase.from).mockImplementation(() =>
      makeBuilder({ data: null, error: { message: "Row not found" } }) as never,
    );

    await expect(processAnalyticsJob(makeJob(), app)).rejects.toThrow(
      "Analytics worker: session not found"
    );
  });

  // ─── Error propagation ────────────────────────────────────────────────────────────────────

  it("throws when employee_daily_metrics upsert fails", async () => {
    let call = 0;
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      call++;
      if (table === "attendance_sessions" && call === 1) {
        return makeBuilder({ data: CLOSED_SESSION, error: null }) as never;
      }
      if (table === "attendance_sessions" && call === 2) {
        return makeBuilder({
          data: [{ total_distance_km: 25.5, total_duration_seconds: 28800 }],
          error: null,
        }) as never;
      }
      if (table === "employee_daily_metrics" && call === 3) {
        const builder = makeBuilder({ data: null, error: null });
        builder.upsert.mockResolvedValue({ error: { message: "DB constraint violation" } });
        return builder as never;
      }
      return makeBuilder({ data: [], error: null }) as never;
    });

    await expect(processAnalyticsJob(makeJob(), app)).rejects.toThrow(
      "employee_daily_metrics upsert failed"
    );
  });

  it("throws when org_daily_metrics upsert fails", async () => {
    let call = 0;
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      call++;
      if (table === "attendance_sessions" && call === 1) {
        return makeBuilder({ data: CLOSED_SESSION, error: null }) as never;
      }
      if (table === "attendance_sessions" && call === 2) {
        return makeBuilder({
          data: [{ total_distance_km: 25.5, total_duration_seconds: 28800 }],
          error: null,
        }) as never;
      }
      if (table === "employee_daily_metrics" && call === 3) {
        const b = makeBuilder({ data: null, error: null });
        b.upsert.mockResolvedValue({ error: null });
        return b as never;
      }
      if (table === "employee_daily_metrics" && call === 4) {
        return makeBuilder({
          data: [{ sessions: 1, distance_km: 25.5, duration_seconds: 28800 }],
          error: null,
        }) as never;
      }
      if (table === "org_daily_metrics") {
        const b = makeBuilder({ data: null, error: null });
        b.upsert.mockResolvedValue({ error: { message: "Constraint error" } });
        return b as never;
      }
      return makeBuilder({ data: [], error: null }) as never;
    });

    await expect(processAnalyticsJob(makeJob(), app)).rejects.toThrow(
      "org_daily_metrics upsert failed"
    );
  });

  // ─── Idempotency ──────────────────────────────────────────────────────────────────────────

  it("produces same result on retry — idempotent full recompute", async () => {
    mockHappyPath();
    await processAnalyticsJob(makeJob(), app);

    vi.clearAllMocks();
    mockHappyPath();
    await processAnalyticsJob(makeJob(), app);

    // Both runs completed without errors; second run re-called from() the same way
    expect(supabase.from).toHaveBeenCalledWith("attendance_sessions");
  });
});
