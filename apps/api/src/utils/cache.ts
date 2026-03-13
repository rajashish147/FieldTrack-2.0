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
  // Intentionally non-crashing — log only, don't rethrow
  console.error("[cache] Redis error:", err.message);
});

/**
 * Cache-aside helper with JSON serialisation.
 *
 * 1. Attempts to read `key` from Redis.
 * 2. On cache hit: parses and returns the stored value.
 * 3. On cache miss or Redis error: executes `fn`, stores the result with
 *    `ttlSeconds`, and returns the result.
 *
 * Type parameter T is the shape of the underlying value.
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
  try {
    const cached = await cacheClient.get(key);
    if (cached !== null) {
      return JSON.parse(cached) as T;
    }
  } catch {
    // Redis read failure — fall through to source
  }

  const result = await fn();

  try {
    await cacheClient.set(key, JSON.stringify(result), "EX", ttlSeconds);
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
 * Call this after:
 *  - Session checkout (distance worker completion)
 *  - Expense submission
 */
export async function invalidateOrgAnalytics(orgId: string): Promise<void> {
  try {
    const pattern = `org:${orgId}:analytics:*`;
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
  } catch {
    // Non-fatal — Redis outage must not block business operations
  }
}
