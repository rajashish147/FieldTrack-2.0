/**
 * circuit-breaker.ts — Per-webhook circuit breaker, Redis + DB persistent.
 *
 * State model
 * ───────────
 *   CLOSED    — normal operation (failure_streak < threshold)
 *   OPEN      — webhook disabled; deliveries are skipped until
 *               circuit_open_until has elapsed
 *   HALF-OPEN — cooldown elapsed; next delivery attempt re-enables the webhook
 *               if it succeeds (or re-opens the circuit if it fails)
 *
 * Persistence strategy
 * ────────────────────
 *   Hot path (per delivery): Redis only (sub-ms reads, atomic INCR)
 *   Cold start / Redis flush: DB is the authoritative source of truth.
 *     - openCircuit()  writes both Redis and DB
 *     - closeCircuit() clears both Redis and DB
 *     - syncCircuitBreakerState() is called once at startup to repopulate
 *       Redis from DB, guaranteeing open circuits survive Redis restarts
 *
 * Redis keys
 * ──────────
 *   cb:failure_streak:{webhookId}    — INCR counter, TTL=24 h
 *   cb:recovery_cooldown:{webhookId} — EX key, TTL=cooldown seconds
 */

import type { FastifyBaseLogger } from "fastify";
import type { Redis as IORedis } from "ioredis";
import { supabaseServiceClient as supabase } from "../config/supabase.js";
import { insertAuditRecord } from "../utils/audit.js";

// ─── Constants ─────────────────────────────────────────────────────────────

/** Consecutive failures required to open the circuit. */
export const CIRCUIT_OPEN_THRESHOLD = 5;

/** How long a webhook stays disabled before auto-recovery attempt (ms). */
export const CIRCUIT_RECOVERY_COOLDOWN_MS = 10 * 60_000; // 10 min

/** How often to scan DB for expired open circuits and re-enable them. */
export const CIRCUIT_RECOVERY_SCAN_INTERVAL_MS = 60_000; // 1 min

/** TTL for the Redis streak key — auto-cleans idle webhooks. */
const STREAK_TTL_SECONDS = 86_400; // 24 h

// ─── Redis key helpers ──────────────────────────────────────────────────────

export function streakKey(webhookId: string): string {
  return `cb:failure_streak:${webhookId}`;
}

export function cooldownKey(webhookId: string): string {
  return `cb:recovery_cooldown:${webhookId}`;
}

// ─── Cold-start sync ────────────────────────────────────────────────────────

/**
 * Re-populate Redis from DB on process start.
 *
 * Reads every webhook row whose circuit_open_until timestamp is still in the
 * future and sets the Redis cooldown key with the remaining TTL.  This ensures
 * that open circuits survive a Redis flush or process restart.
 *
 * Call once from server.ts after workers are started.
 */
export async function syncCircuitBreakerState(
  redis: IORedis,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    const { data: openWebhooks, error } = await supabase
      .from("webhooks")
      .select("id, circuit_open_until, failure_streak")
      .gt("circuit_open_until", now);

    if (error) {
      log.warn({ error: error.message }, "circuit-breaker: startup sync DB query failed");
      return;
    }

    if (!openWebhooks?.length) {
      log.info("circuit-breaker: startup sync — no open circuits found");
      return;
    }

    const pipeline = redis.pipeline();
    for (const wh of openWebhooks) {
      const openUntil = new Date(wh.circuit_open_until as string).getTime();
      const remainingMs = openUntil - Date.now();
      if (remainingMs <= 0) continue;

      const remainingSec = Math.ceil(remainingMs / 1000);
      pipeline.set(cooldownKey(wh.id as string), "1", "EX", remainingSec);
      if ((wh.failure_streak as number) > 0) {
        pipeline.set(streakKey(wh.id as string), String(wh.failure_streak));
        pipeline.expire(streakKey(wh.id as string), STREAK_TTL_SECONDS);
      }
    }
    await pipeline.exec();

    log.info(
      { count: openWebhooks.length },
      "circuit-breaker: startup sync — restored open circuits from DB",
    );
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "circuit-breaker: startup sync failed (non-fatal)",
    );
  }
}

// ─── Per-delivery operations ────────────────────────────────────────────────

/**
 * Record a successful delivery — resets failure streak in both Redis and DB.
 */
export async function recordDeliverySuccess(
  webhookId: string,
  redis: IORedis,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const key = streakKey(webhookId);
    const prev = await redis.getdel(key);
    const prevStreak = prev ? parseInt(prev, 10) : 0;

    if (prevStreak > 0) {
      log.info(
        { webhookId, previousStreak: prevStreak, circuitBreaker: "reset" },
        "circuit-breaker: streak reset after successful delivery",
      );
      // Persist the cleared streak to DB (non-blocking — failure is non-fatal)
      supabase
        .from("webhooks")
        .update({ failure_streak: 0 })
        .eq("id", webhookId)
        .then(({ error }) => {
          if (error) {
            log.warn({ webhookId, error: error.message }, "circuit-breaker: failed to persist streak reset to DB");
          }
        });
    }
  } catch (err) {
    log.warn(
      { webhookId, error: err instanceof Error ? err.message : String(err) },
      "circuit-breaker: failed to reset streak (Redis error)",
    );
  }
}

/**
 * Record a delivery failure — increments streak in Redis + DB,
 * opens the circuit if the threshold is reached.
 *
 * @returns current streak count
 */
export async function recordDeliveryFailure(
  webhookId: string,
  redis: IORedis,
  log: FastifyBaseLogger,
): Promise<number> {
  try {
    const key = streakKey(webhookId);
    const streak = await redis.incr(key);
    await redis.expire(key, STREAK_TTL_SECONDS);

    log.info(
      { webhookId, streak, threshold: CIRCUIT_OPEN_THRESHOLD, circuitBreaker: "failure" },
      "circuit-breaker: failure recorded",
    );

    // Persist streak to DB every increment so restarts see the latest value.
    // Fire-and-forget — delivery path must not block on DB write.
    supabase
      .from("webhooks")
      .update({ failure_streak: streak })
      .eq("id", webhookId)
      .then(({ error }) => {
        if (error) {
          log.warn({ webhookId, error: error.message }, "circuit-breaker: failed to persist streak to DB");
        }
      });

    if (streak >= CIRCUIT_OPEN_THRESHOLD) {
      await openCircuit(webhookId, streak, redis, log);
    }

    return streak;
  } catch (err) {
    log.warn(
      { webhookId, error: err instanceof Error ? err.message : String(err) },
      "circuit-breaker: failed to record failure (Redis error)",
    );
    return 0;
  }
}

// ─── Circuit open / close ───────────────────────────────────────────────────

/**
 * Open the circuit — disable the webhook in DB + set Redis cooldown key.
 * Writes `circuit_open_until` to the webhooks row for cross-restart persistence.
 */
async function openCircuit(
  webhookId: string,
  streak: number,
  redis: IORedis,
  log: FastifyBaseLogger,
): Promise<void> {
  const cooldownSeconds = Math.ceil(CIRCUIT_RECOVERY_COOLDOWN_MS / 1000);
  const openUntil = new Date(Date.now() + CIRCUIT_RECOVERY_COOLDOWN_MS).toISOString();

  log.warn(
    {
      webhookId,
      streak,
      threshold: CIRCUIT_OPEN_THRESHOLD,
      recoveryCooldownMs: CIRCUIT_RECOVERY_COOLDOWN_MS,
      circuitBreaker: "open",
    },
    "circuit-breaker: OPEN — disabling webhook temporarily",
  );

  // DB write: persist open state + timestamp so it survives restarts.
  const { error } = await supabase
    .from("webhooks")
    .update({
      is_active:          false,
      failure_streak:     streak,
      circuit_open_until: openUntil,
    })
    .eq("id", webhookId);

  if (error) {
    log.error(
      { webhookId, error: error.message },
      "circuit-breaker: failed to persist OPEN state to DB",
    );
    // Still set Redis key so in-process workers respect the circuit.
  }

  // Redis cooldown key: hot-path check
  await redis.set(cooldownKey(webhookId), "1", "EX", cooldownSeconds);

  log.warn(
    { webhookId, cooldownSeconds, openUntil, circuitBreaker: "open" },
    "circuit-breaker: webhook disabled, auto-recovery scheduled",
  );

  await insertAuditRecord({
    event:         "CIRCUIT_BREAKER_OPENED",
    resource_type: "webhook",
    resource_id:   webhookId,
    payload:       { streak, threshold: CIRCUIT_OPEN_THRESHOLD, cooldown_seconds: cooldownSeconds, open_until: openUntil },
  });
}

/**
 * Check if a webhook's circuit is ready for auto-recovery.
 * Checks Redis first (fast), falls back to DB (resilient).
 *
 * @returns true if the cooldown has elapsed and circuit can be closed
 */
export async function isCircuitReadyToRecover(
  webhookId: string,
  redis: IORedis,
): Promise<boolean> {
  // Primary: Redis TTL-based check
  try {
    const exists = await redis.exists(cooldownKey(webhookId));
    if (exists === 1) return false; // cooldown still active
  } catch {
    // Redis unavailable — fall through to DB check
  }

  // Fallback: DB authoritative check
  const { data } = await supabase
    .from("webhooks")
    .select("circuit_open_until")
    .eq("id", webhookId)
    .single();

  if (!data?.circuit_open_until) return true; // no open circuit in DB
  return new Date(data.circuit_open_until as string) <= new Date();
}

/**
 * Close the circuit — re-enable the webhook, clear streak, clear cooldown.
 * Writes to both DB and Redis.
 */
export async function closeCircuit(
  webhookId: string,
  redis: IORedis,
  log: FastifyBaseLogger,
): Promise<void> {
  log.info(
    { webhookId, circuitBreaker: "closed" },
    "circuit-breaker: CLOSED — re-enabling webhook",
  );

  // DB: re-enable and clear circuit state
  const { error } = await supabase
    .from("webhooks")
    .update({
      is_active:          true,
      failure_streak:     0,
      circuit_open_until: null,
    })
    .eq("id", webhookId);

  if (error) {
    log.error({ webhookId, error: error.message }, "circuit-breaker: failed to persist CLOSED state to DB");
  }

  // Redis: clear streak + cooldown keys
  await redis.del(streakKey(webhookId));
  await redis.del(cooldownKey(webhookId));

  await insertAuditRecord({
    event:         "CIRCUIT_BREAKER_CLOSED",
    resource_type: "webhook",
    resource_id:   webhookId,
    payload:       {},
  });
}

/** Interval handle so the recovery scanner is started only once per process. */
let _circuitRecoveryInterval: ReturnType<typeof setInterval> | undefined;

/**
 * Find all expired open circuits and close them.
 *
 * This restores webhook activity after cooldown without requiring a new
 * delivery attempt to trigger recovery logic.
 */
export async function recoverExpiredCircuits(
  redis: IORedis,
  log: FastifyBaseLogger,
): Promise<number> {
  const now = new Date().toISOString();

  const { data: recoverable, error } = await supabase
    .from("webhooks")
    .select("id")
    .eq("is_active", false)
    .not("circuit_open_until", "is", null)
    .lte("circuit_open_until", now)
    .limit(500);

  if (error) {
    log.warn({ error: error.message }, "circuit-breaker: recovery scan query failed");
    return 0;
  }

  if (!recoverable?.length) return 0;

  let recovered = 0;
  for (const row of recoverable as Array<{ id: string }>) {
    try {
      await closeCircuit(row.id, redis, log);
      recovered++;
    } catch (err) {
      log.warn(
        {
          webhookId: row.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "circuit-breaker: failed to recover expired circuit",
      );
    }
  }

  if (recovered > 0) {
    log.info({ recovered }, "circuit-breaker: recovered expired circuits");
  }

  return recovered;
}

/** Start periodic scan that closes circuits after cooldown expiration. */
export function startCircuitRecoveryInterval(
  redis: IORedis,
  log: FastifyBaseLogger,
): ReturnType<typeof setInterval> {
  if (_circuitRecoveryInterval) return _circuitRecoveryInterval;

  void recoverExpiredCircuits(redis, log);
  _circuitRecoveryInterval = setInterval(
    () => {
      void recoverExpiredCircuits(redis, log);
    },
    CIRCUIT_RECOVERY_SCAN_INTERVAL_MS,
  );
  _circuitRecoveryInterval.unref();
  return _circuitRecoveryInterval;
}
