import { Redis } from "ioredis";
import { env } from "../config/env.js";

/**
 * Dedicated ioredis client for application-level caching.
 *
 * Intentionally separate from the BullMQ connection in config/redis.ts:
 *  - BullMQ requires maxRetriesPerRequest: null (blocking commands need infinite retries)
 *  - A cache client should fail fast (maxRetriesPerRequest: 3) so stale reads
 *    fall through to the database rather than hanging indefinitely.
 *
 * Cache failures are non-fatal — all helpers catch errors and fall through to
 * the underlying data source, keeping the API available when Redis is degraded.
 */
const cacheClient = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  lazyConnect: true,
});

cacheClient.on("error", (err: Error) => {
  // Intentionally non-crashing — log only, don't rethrow.
  //
  // console.error is deliberately avoided here: it produces an unstructured
  // string that bypasses Pino and is therefore invisible in Loki / Grafana.
  //
  // Writing structured JSON to stderr mirrors what Pino does internally and
  // is picked up by Docker's log driver → Promtail → Loki exactly like any
  // other application log line.  The `component` field makes it filterable:
  //   {component="cache"} |= "Redis cache client error"
  process.stderr.write(
    JSON.stringify({
      level: "error",
      time: Date.now(),
      component: "cache",
      msg: "Redis cache client error",
      err: { message: err.message, name: err.name },
    }) + "\n",
  );
});

// ─── L1: in-process memory cache ─────────────────────────────────────────────
//
// Acts as a write-through layer in front of Redis (L2).  A hit here costs
// ~0.1 ms (Map lookup + JSON parse) vs ~2 ms for a Redis round-trip or
// ~150–400 ms for a Supabase query.
//
// Crucially this layer works even when Redis is unreachable: the very first
// request for a key fills L1, and ALL subsequent requests in the same process
// — including 49 concurrent VUs polling the same endpoint — read from memory.
//
// Design:
//  - Bounded at L1_MAX entries; evicts the oldest key (insertion-order Map).
//  - TTL is stored as an absolute expiry timestamp (Date.now() + ttl * 1000).
//  - invalidateOrgAnalytics() clears matching keys via a prefix sweep.

const L1_MAX = 1000;
const l1Cache = new Map<string, { val: string; exp: number }>();

function l1Get(key: string): string | null {
  const entry = l1Cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    l1Cache.delete(key);
    return null;
  }
  return entry.val;
}

function l1Set(key: string, val: string, ttlSeconds: number): void {
  if (l1Cache.size >= L1_MAX) {
    // Map preserves insertion order — delete the first (oldest) entry.
    l1Cache.delete(l1Cache.keys().next().value!);
  }
  l1Cache.set(key, { val, exp: Date.now() + ttlSeconds * 1000 });
}

/** Delete all L1 entries whose key starts with `prefix`. */
function l1DelPrefix(prefix: string): void {
  for (const key of l1Cache.keys()) {
    if (key.startsWith(prefix)) l1Cache.delete(key);
  }
}

/**
 * Cache-aside helper with JSON serialisation.
 *
 * Read path:  L1 (process memory) → L2 (Redis) → factory (DB)
 * Write path: always writes to both L1 and L2 on a miss.
 *
 * L1 ensures that even when Redis is unreachable (e.g. wrong host in Docker),
 * warm reads within the same process are sub-millisecond.  The very first
 * request for a key hits the DB; all subsequent requests in the same process
 * are served from L1 until the TTL expires.
 *
 * @param key        Cache key (namespaced by caller)
 * @param ttlSeconds TTL in seconds; use 300 for the standard 5-minute analytics TTL
 * @param fn         Async factory — called only on cache miss
 */
export async function getCached<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  // ── L1: in-process memory (sub-millisecond) ──────────────────────────────
  const l1 = l1Get(key);
  if (l1 !== null) return JSON.parse(l1) as T;

  // ── L2: Redis ────────────────────────────────────────────────────────────
  try {
    const cached = await cacheClient.get(key);
    if (cached !== null) {
      l1Set(key, cached, ttlSeconds); // back-fill L1 for the next request
      return JSON.parse(cached) as T;
    }
  } catch {
    // Redis read failure — fall through to source
  }

  // ── Source: factory (DB query) ───────────────────────────────────────────
  const result = await fn();
  const json = JSON.stringify(result);

  l1Set(key, json, ttlSeconds); // always populate L1
  try {
    await cacheClient.set(key, json, "EX", ttlSeconds);
  } catch {
    // Redis write failure — non-fatal; result is still returned to caller
  }

  return result;
}

/** 5-minute TTL used by all analytics cache entries. */
export const ANALYTICS_CACHE_TTL = 300;

/**
 * Invalidate all analytics cache entries for an organisation.
 *
 * Uses SCAN (not KEYS) to iterate lazily over matching keys so the Redis
 * server is never blocked on a large keyspace. Non-fatal: errors are swallowed
 * so a Redis outage never prevents checkout or expense creation from completing.
 *
 * Also explicitly deletes the dashboard snapshot key and sweeps the sessions
 * cache so that admin polling always reflects the most recent checkout state.
 *
 * Call this after:
 *  - Session checkout (distance worker completion)
 *  - Expense submission
 */
export async function invalidateOrgAnalytics(orgId: string): Promise<void> {
  // Always clear L1 immediately — no network required, safe even when Redis is down.
  l1DelPrefix(`org:${orgId}:`);

  try {
    // Helper: SCAN a Redis key pattern and delete all matching keys.
    const scanAndDelete = async (pattern: string): Promise<void> => {
      let cursor = "0";
      do {
        const [nextCursor, keys] = await cacheClient.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          100,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          await cacheClient.del(...keys);
        }
      } while (cursor !== "0");
    };

    // 1. Pattern sweep: clears trend, leaderboard, summary, and any other
    //    analytics keys stored under org:{orgId}:analytics:*.
    await scanAndDelete(`org:${orgId}:analytics:*`);

    // 2. Sessions cache — org:{orgId}:sessions:{page}:{limit}:{status}:{empId}
    await scanAndDelete(`org:${orgId}:sessions:*`);

    // 3. Explicit deletes for dashboard keys.
    //    org:{orgId}:dashboard:snap — Phase 24 (revised) snapshot-only cache key.
    //    org:{orgId}:dashboard      — Phase 24 original key (belt-and-suspenders).
    await cacheClient.del(
      `org:${orgId}:dashboard:snap`,
      `org:${orgId}:dashboard`,
    );
  } catch {
    // Non-fatal — Redis outage must not block business operations
  }
}
