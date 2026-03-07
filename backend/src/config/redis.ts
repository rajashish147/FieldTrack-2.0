import { env } from "./env.js";

/**
 * Phase 10: Redis connection options for BullMQ Queue and Worker.
 *
 * BullMQ bundles its own ioredis internally — we pass plain connection options
 * rather than an external ioredis instance to avoid version incompatibility.
 *
 * maxRetriesPerRequest: null — required by BullMQ for blocking commands
 * enableReadyCheck: false  — prevents startup delays in containerised envs
 */
function parseRedisUrl(redisUrl: string): {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db?: number;
  maxRetriesPerRequest: null;
  enableReadyCheck: false;
  tls?: Record<string, unknown>;
} {
  // Guard: new URL() will silently mis-parse bare "host:port" strings
  // (hostname comes out empty, fallback was 127.0.0.1 — deadly in Docker).
  if (!redisUrl.startsWith("redis://") && !redisUrl.startsWith("rediss://")) {
    throw new Error(
      `REDIS_URL must start with redis:// or rediss://. Got: "${redisUrl}". ` +
      `Example: redis://redis:6379`,
    );
  }

  const u = new URL(redisUrl);

  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 6379,
    password: u.password || undefined,
    username: u.username || undefined,
    db: u.pathname && u.pathname.length > 1
      ? parseInt(u.pathname.slice(1), 10)
      : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Enable TLS for rediss:// scheme (Redis with SSL — common in managed Redis)
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export const redisConnectionOptions = parseRedisUrl(env.REDIS_URL);

