import { env } from "./env.js";

/**
 * Phase 10: Redis connection options for BullMQ Queue and Worker.
 *
 * BullMQ bundles its own ioredis internally — we pass plain connection options
 * rather than an external ioredis instance to avoid version incompatibility.
 *
 * maxRetriesPerRequest: null — required by BullMQ for blocking commands
 * enableReadyCheck: false  — prevents startup delays in containerised envs
 *
 * Lazy: computed on first access so importing this module has no side effects.
 */

type RedisConnectionOptions = {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db?: number;
  maxRetriesPerRequest: null;
  enableReadyCheck: false;
  tls?: Record<string, unknown>;
};

function parseRedisUrl(redisUrl: string): RedisConnectionOptions {
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

let _redisOpts: RedisConnectionOptions | undefined;

export function getRedisConnectionOptions(): RedisConnectionOptions {
  if (!_redisOpts) {
    _redisOpts = parseRedisUrl(env.REDIS_URL);
  }
  return _redisOpts;
}

/** @deprecated Use getRedisConnectionOptions() for lazy access */
export const redisConnectionOptions: RedisConnectionOptions = new Proxy(
  {} as RedisConnectionOptions,
  {
    get(_target, prop, receiver) {
      return Reflect.get(getRedisConnectionOptions(), prop, receiver);
    },
    has(_target, prop) {
      return prop in getRedisConnectionOptions();
    },
    ownKeys() {
      return Reflect.ownKeys(getRedisConnectionOptions());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const opts = getRedisConnectionOptions();
      if (prop in opts) {
        return {
          configurable: true,
          enumerable: true,
          value: (opts as Record<string | symbol, unknown>)[prop],
        };
      }
      return undefined;
    },
  },
);

