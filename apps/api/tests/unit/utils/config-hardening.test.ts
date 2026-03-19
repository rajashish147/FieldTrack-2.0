/**
 * config-hardening.test.ts
 *
 * Verification suite for every hardening change made in this refactor:
 *
 *   1. normalizeUrl  — strips trailing slashes, never touches mid-path slashes
 *   2. URL normalisation in env schema — optionalBaseUrl preprocessor
 *   3. PORT bounds  — 1000–65535
 *   4. ANALYTICS_WORKER_CONCURRENCY bounds  — 1–50
 *   5. CONFIG_VERSION literal  — must be "1", default is "1"
 *   6. Strict CORS  — resolveOrigins never returns a wildcard
 *   7. publicEnv    — contains only non-secret fields
 *   8. privateEnv   — contains secret fields; publicEnv does NOT
 *   9. logStartupConfig  — calls logger.info exactly once with safe payload
 *  10. APP_BASE_URL — optional field present in schema, required in production
 *
 * These tests are intentionally isolated from the database, Redis, and any
 * external services.  They operate purely on plain functions and Zod schemas.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Unit under test: normalizeUrl ───────────────────────────────────────────

import { normalizeUrl } from "../../../src/utils/url.js";

// ─── Unit under test: env exports ────────────────────────────────────────────

// env is already loaded (env-setup.ts runs before this file via setupFiles).
// We import the stable exported helpers — not the full env object — to keep
// tests independent of the running process environment.
import {
  env,
  corsOrigins,
  publicEnv,
  privateEnv,
  logStartupConfig,
} from "../../../src/config/env.js";

// ─── Zod schema import for isolated bounds tests ──────────────────────────────
// We test the schema directly by re-parsing crafted inputs, which means we
// need access to the raw schema.  Because the schema is not exported from
// env.ts (by design — callers use the pre-parsed `env` object), we import
// Zod here and rebuild the narrow sub-schemas needed for bounds testing.
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// 1. normalizeUrl
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeUrl", () => {
  it("removes a single trailing slash", () => {
    expect(normalizeUrl("https://api.example.com/")).toBe(
      "https://api.example.com",
    );
  });

  it("removes multiple consecutive trailing slashes", () => {
    expect(normalizeUrl("https://api.example.com///")).toBe(
      "https://api.example.com",
    );
  });

  it("is a no-op when there is no trailing slash", () => {
    expect(normalizeUrl("https://api.example.com")).toBe(
      "https://api.example.com",
    );
  });

  it("preserves mid-path slashes untouched", () => {
    expect(normalizeUrl("https://api.example.com/v1/users")).toBe(
      "https://api.example.com/v1/users",
    );
  });

  it("removes trailing slash from path-containing URL", () => {
    expect(normalizeUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1",
    );
  });

  it("handles localhost with port", () => {
    expect(normalizeUrl("http://localhost:3000/")).toBe(
      "http://localhost:3000",
    );
  });

  it("handles localhost with port and no trailing slash", () => {
    expect(normalizeUrl("http://localhost:5173")).toBe(
      "http://localhost:5173",
    );
  });

  it("is idempotent — applying twice yields the same result", () => {
    const url = "https://api.example.com/";
    expect(normalizeUrl(normalizeUrl(url))).toBe(normalizeUrl(url));
  });

  it("does not alter the protocol double-slash", () => {
    const url = "https://api.example.com";
    expect(normalizeUrl(url)).toMatch(/^https:\/\//);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. URL normalisation baked into env schema
// ─────────────────────────────────────────────────────────────────────────────
//
// The test environment sets API_BASE_URL / FRONTEND_BASE_URL via env-setup.ts,
// but those values do NOT include trailing slashes, so we validate the
// normalisation contract by confirming the parsed values never end with "/".

describe("env schema — URL normalisation", () => {
  it("env.API_BASE_URL does not end with a trailing slash (if set)", () => {
    if (env.API_BASE_URL !== undefined) {
      expect(env.API_BASE_URL).not.toMatch(/\/$/);
    }
  });

  it("env.FRONTEND_BASE_URL does not end with a trailing slash (if set)", () => {
    if (env.FRONTEND_BASE_URL !== undefined) {
      expect(env.FRONTEND_BASE_URL).not.toMatch(/\/$/);
    }
  });

  it("env.APP_BASE_URL does not end with a trailing slash (if set)", () => {
    if (env.APP_BASE_URL !== undefined) {
      expect(env.APP_BASE_URL).not.toMatch(/\/$/);
    }
  });

  it("optionalBaseUrl preprocessor: trailing slash is stripped when the field is set", () => {
    // Re-build the same preprocessor logic used in env.ts to unit-test it
    // in isolation without re-loading the full module with different env vars.
    const optionalBaseUrl = z.preprocess(
      (val) =>
        typeof val === "string" && val.trim().length > 0
          ? normalizeUrl(val.trim())
          : undefined,
      z.string().url().optional(),
    );

    expect(optionalBaseUrl.parse("https://api.example.com/")).toBe(
      "https://api.example.com",
    );
    expect(optionalBaseUrl.parse("https://api.example.com///")).toBe(
      "https://api.example.com",
    );
    expect(optionalBaseUrl.parse("https://api.example.com")).toBe(
      "https://api.example.com",
    );
  });

  it("optionalBaseUrl preprocessor: empty string produces undefined", () => {
    const optionalBaseUrl = z.preprocess(
      (val) =>
        typeof val === "string" && val.trim().length > 0
          ? normalizeUrl(val.trim())
          : undefined,
      z.string().url().optional(),
    );

    expect(optionalBaseUrl.parse("")).toBeUndefined();
    expect(optionalBaseUrl.parse("   ")).toBeUndefined();
  });

  it("optionalBaseUrl preprocessor: undefined input produces undefined", () => {
    const optionalBaseUrl = z.preprocess(
      (val) =>
        typeof val === "string" && val.trim().length > 0
          ? normalizeUrl(val.trim())
          : undefined,
      z.string().url().optional(),
    );

    expect(optionalBaseUrl.parse(undefined)).toBeUndefined();
  });

  it("path concatenation is safe after normalisation — no double slash", () => {
    const optionalBaseUrl = z.preprocess(
      (val) =>
        typeof val === "string" && val.trim().length > 0
          ? normalizeUrl(val.trim())
          : undefined,
      z.string().url().optional(),
    );

    const base = optionalBaseUrl.parse("https://api.example.com/") as string;
    const full = `${base}/v1/users`;
    expect(full).toBe("https://api.example.com/v1/users");
    expect(full).not.toContain("//v1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PORT bounds: 1000–65535
// ─────────────────────────────────────────────────────────────────────────────

describe("env schema — PORT bounds", () => {
  const portSchema = z.coerce.number().int().min(1000).max(65535).default(3000);

  it("accepts 3000 (default)", () => {
    expect(portSchema.parse(3000)).toBe(3000);
  });

  it("accepts 1000 (lower bound)", () => {
    expect(portSchema.parse(1000)).toBe(1000);
  });

  it("accepts 65535 (upper bound)", () => {
    expect(portSchema.parse(65535)).toBe(65535);
  });

  it("accepts common dev ports: 3001, 4000, 5173, 8080", () => {
    for (const port of [3001, 4000, 5173, 8080]) {
      expect(portSchema.parse(port)).toBe(port);
    }
  });

  it("rejects 999 (below lower bound)", () => {
    expect(() => portSchema.parse(999)).toThrow();
  });

  it("rejects 80 (privileged port)", () => {
    expect(() => portSchema.parse(80)).toThrow();
  });

  it("rejects 0", () => {
    expect(() => portSchema.parse(0)).toThrow();
  });

  it("rejects 65536 (above upper bound)", () => {
    expect(() => portSchema.parse(65536)).toThrow();
  });

  it("coerces a numeric string", () => {
    expect(portSchema.parse("3000")).toBe(3000);
  });

  it("the live env.PORT is within the valid range", () => {
    expect(env.PORT).toBeGreaterThanOrEqual(1000);
    expect(env.PORT).toBeLessThanOrEqual(65535);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ANALYTICS_WORKER_CONCURRENCY bounds: 1–50
// ─────────────────────────────────────────────────────────────────────────────

describe("env schema — ANALYTICS_WORKER_CONCURRENCY bounds", () => {
  const concurrencySchema = z.coerce.number().int().min(1).max(50).default(5);

  it("accepts 1 (minimum)", () => {
    expect(concurrencySchema.parse(1)).toBe(1);
  });

  it("accepts 5 (default)", () => {
    expect(concurrencySchema.parse(5)).toBe(5);
  });

  it("accepts 50 (maximum)", () => {
    expect(concurrencySchema.parse(50)).toBe(50);
  });

  it("rejects 0", () => {
    expect(() => concurrencySchema.parse(0)).toThrow();
  });

  it("rejects 51 (above maximum)", () => {
    expect(() => concurrencySchema.parse(51)).toThrow();
  });

  it("rejects negative values", () => {
    expect(() => concurrencySchema.parse(-1)).toThrow();
  });

  it("coerces a numeric string", () => {
    expect(concurrencySchema.parse("10")).toBe(10);
  });

  it("the live env.ANALYTICS_WORKER_CONCURRENCY is within the valid range", () => {
    expect(env.ANALYTICS_WORKER_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(env.ANALYTICS_WORKER_CONCURRENCY).toBeLessThanOrEqual(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. CONFIG_VERSION literal
// ─────────────────────────────────────────────────────────────────────────────

describe("env schema — CONFIG_VERSION", () => {
  const versionSchema = z.literal("1").default("1");

  it('accepts "1"', () => {
    expect(versionSchema.parse("1")).toBe("1");
  });

  it("defaults to \"1\" when undefined", () => {
    expect(versionSchema.parse(undefined)).toBe("1");
  });

  it('rejects "2"', () => {
    expect(() => versionSchema.parse("2")).toThrow();
  });

  it('rejects "1.0"', () => {
    expect(() => versionSchema.parse("1.0")).toThrow();
  });

  it("rejects the number 1 (must be string)", () => {
    expect(() => versionSchema.parse(1)).toThrow();
  });

  it("the live env.CONFIG_VERSION is \"1\"", () => {
    expect(env.CONFIG_VERSION).toBe("1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Strict CORS — resolveOrigins never returns a wildcard
// ─────────────────────────────────────────────────────────────────────────────
//
// We cannot import resolveOrigins directly because it is module-private.
// We test it indirectly through the corsOrigins export and by re-implementing
// the identical logic here to verify its contract for every input combination.

describe("strict CORS — resolveOrigins contract", () => {
  const DEV_CORS_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5173",
  ] as const;

  /** Mirror of the private resolveOrigins function in cors.plugin.ts */
  function resolveOrigins(
    appEnv: string,
    configured: readonly string[],
  ): string[] {
    if (configured.length > 0) return [...configured];
    if (appEnv === "development") return [...DEV_CORS_ORIGINS];
    return [];
  }

  it("never returns the boolean true (no wildcard)", () => {
    const variants: [string, string[]][] = [
      ["development", []],
      ["development", ["http://localhost:3000"]],
      ["production", ["https://app.example.com"]],
      ["staging", ["https://staging.example.com"]],
      ["test", ["http://localhost:3000"]],
    ];
    for (const [appEnv, configured] of variants) {
      const result = resolveOrigins(appEnv, configured);
      // The result must be an array, never a boolean
      expect(Array.isArray(result)).toBe(true);
    }
  });

  it("uses CORS_ORIGIN when set, regardless of environment", () => {
    const explicit = ["https://app.fieldtrack.com"];
    expect(resolveOrigins("development", explicit)).toEqual(explicit);
    expect(resolveOrigins("production", explicit)).toEqual(explicit);
    expect(resolveOrigins("staging", explicit)).toEqual(explicit);
  });

  it("falls back to DEV_CORS_ORIGINS in development when CORS_ORIGIN is empty", () => {
    const result = resolveOrigins("development", []);
    expect(result).toContain("http://localhost:3000");
    expect(result).toContain("http://localhost:5173");
    expect(result.length).toBeGreaterThan(0);
  });

  it("DEV_CORS_ORIGINS fallback contains only localhost origins", () => {
    const result = resolveOrigins("development", []);
    for (const origin of result) {
      expect(origin).toMatch(/^http:\/\/localhost:/);
    }
  });

  it("returns empty array (deny-all) when CORS_ORIGIN is empty and env is not development", () => {
    // This path is blocked at startup in production by superRefine,
    // but we confirm the fallback is safe (deny-all) not unsafe (allow-all).
    expect(resolveOrigins("production", [])).toEqual([]);
    expect(resolveOrigins("staging", [])).toEqual([]);
  });

  it("supports multiple origins from CORS_ORIGIN", () => {
    const multi = [
      "https://app.fieldtrack.com",
      "https://admin.fieldtrack.com",
    ];
    const result = resolveOrigins("production", multi);
    expect(result).toEqual(multi);
    expect(result).toHaveLength(2);
  });

  it("corsOrigins export from env.ts is always a string[] (never boolean)", () => {
    expect(Array.isArray(corsOrigins)).toBe(true);
  });

  it("corsOrigins entries are non-empty strings", () => {
    for (const origin of corsOrigins) {
      expect(typeof origin).toBe("string");
      expect(origin.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 & 8. publicEnv / privateEnv split
// ─────────────────────────────────────────────────────────────────────────────

describe("publicEnv — safe-to-expose config subset", () => {
  it("contains APP_ENV", () => {
    expect(publicEnv).toHaveProperty("APP_ENV");
  });

  it("contains PORT", () => {
    expect(publicEnv).toHaveProperty("PORT");
  });

  it("contains SERVICE_NAME", () => {
    expect(publicEnv).toHaveProperty("SERVICE_NAME");
  });

  it("contains CONFIG_VERSION", () => {
    expect(publicEnv).toHaveProperty("CONFIG_VERSION");
  });

  it("contains API_BASE_URL key (value may be undefined in test env)", () => {
    expect("API_BASE_URL" in publicEnv).toBe(true);
  });

  it("contains FRONTEND_BASE_URL key (value may be undefined in test env)", () => {
    expect("FRONTEND_BASE_URL" in publicEnv).toBe(true);
  });

  it("contains APP_BASE_URL key (value may be undefined in test env)", () => {
    expect("APP_BASE_URL" in publicEnv).toBe(true);
  });

  it("does NOT contain SUPABASE_SERVICE_ROLE_KEY", () => {
    expect(publicEnv).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("does NOT contain SUPABASE_JWT_SECRET", () => {
    expect(publicEnv).not.toHaveProperty("SUPABASE_JWT_SECRET");
  });

  it("does NOT contain METRICS_SCRAPE_TOKEN", () => {
    expect(publicEnv).not.toHaveProperty("METRICS_SCRAPE_TOKEN");
  });

  it("does NOT contain REDIS_URL", () => {
    expect(publicEnv).not.toHaveProperty("REDIS_URL");
  });

  it("does NOT contain SUPABASE_ANON_KEY", () => {
    expect(publicEnv).not.toHaveProperty("SUPABASE_ANON_KEY");
  });

  it("publicEnv.APP_ENV matches live env.APP_ENV", () => {
    expect(publicEnv.APP_ENV).toBe(env.APP_ENV);
  });

  it("publicEnv.PORT matches live env.PORT", () => {
    expect(publicEnv.PORT).toBe(env.PORT);
  });

  it("publicEnv.CONFIG_VERSION is \"1\"", () => {
    expect(publicEnv.CONFIG_VERSION).toBe("1");
  });
});

describe("privateEnv — secret config subset", () => {
  it("contains SUPABASE_SERVICE_ROLE_KEY", () => {
    expect(privateEnv).toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("contains SUPABASE_JWT_SECRET", () => {
    expect(privateEnv).toHaveProperty("SUPABASE_JWT_SECRET");
  });

  it("contains METRICS_SCRAPE_TOKEN key (value may be undefined in test env)", () => {
    expect("METRICS_SCRAPE_TOKEN" in privateEnv).toBe(true);
  });

  it("contains REDIS_URL", () => {
    expect(privateEnv).toHaveProperty("REDIS_URL");
  });

  it("does NOT contain APP_ENV", () => {
    expect(privateEnv).not.toHaveProperty("APP_ENV");
  });

  it("does NOT contain PORT", () => {
    expect(privateEnv).not.toHaveProperty("PORT");
  });

  it("does NOT contain API_BASE_URL", () => {
    expect(privateEnv).not.toHaveProperty("API_BASE_URL");
  });

  it("privateEnv.SUPABASE_SERVICE_ROLE_KEY is a non-empty string", () => {
    expect(typeof privateEnv.SUPABASE_SERVICE_ROLE_KEY).toBe("string");
    expect(privateEnv.SUPABASE_SERVICE_ROLE_KEY.length).toBeGreaterThan(0);
  });

  it("privateEnv.REDIS_URL starts with redis:// or rediss://", () => {
    expect(privateEnv.REDIS_URL).toMatch(/^rediss?:\/\//);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. logStartupConfig
// ─────────────────────────────────────────────────────────────────────────────

describe("logStartupConfig", () => {
  it("calls logger.info exactly once", () => {
    const logger = { info: vi.fn() };
    logStartupConfig(logger);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('uses the "startup:config" message', () => {
    const logger = { info: vi.fn() };
    logStartupConfig(logger);
    const [, message] = logger.info.mock.calls[0] as [unknown, string];
    expect(message).toBe("startup:config");
  });

  it("includes appEnv in the logged payload", () => {
    const logger = { info: vi.fn() };
    logStartupConfig(logger);
    const [payload] = logger.info.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toHaveProperty("appEnv");
  });

  it("includes port in the logged payload", () => {
    const logger = { info: vi.fn() };
    logStartupConfig(logger);
    const [payload] = logger.info.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toHaveProperty("port");
  });

  it("includes serviceName in the logged payload", () => {
    const logger = { info: vi.fn() };
    logStartupConfig(logger);
    const [payload] = logger.info.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toHaveProperty("serviceName");
  });

  it("includes configVersion in the logged payload", () => {
    const logger = { info: vi.fn() };
    logStartupConfig(logger);
    const [payload] = logger.info.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toHaveProperty("configVersion");
    expect(payload["configVersion"]).toBe("1");
  });

  it("includes tempoEndpoint in the logged payload", () => {
    const logger = { info: vi.fn() };
    logStartupConfig(logger);
    const [payload] = logger.info.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toHaveProperty("tempoEndpoint");
  });

  it("does NOT include SUPABASE_SERVICE_ROLE_KEY in the logged payload", () => {
    const logger = { info: vi.fn() };
    logStartupConfig(logger);
    const [payload] = logger.info.mock.calls[0] as [Record<string, unknown>];
    const payloadStr = JSON.stringify(payload);
    expect(payloadStr).not.toContain("SERVICE_ROLE");
    expect(payloadStr).not.toContain(env.SUPABASE_SERVICE_ROLE_KEY);
  });

  it("does NOT include SUPABASE_JWT_SECRET in the logged payload", () => {
    const logger = { info: vi.fn() };
    logStartupConfig(logger);
    const [payload] = logger.info.mock.calls[0] as [Record<string, unknown>];
    const payloadStr = JSON.stringify(payload);
    expect(payloadStr).not.toContain("JWT_SECRET");
    expect(payloadStr).not.toContain(env.SUPABASE_JWT_SECRET);
  });

  it("does NOT include raw REDIS_URL in the logged payload (may contain password)", () => {
    const logger = { info: vi.fn() };
    logStartupConfig(logger);
    const [payload] = logger.info.mock.calls[0] as [Record<string, unknown>];
    expect(payload).not.toHaveProperty("REDIS_URL");
    expect(payload).not.toHaveProperty("redisUrl");
  });

  it("does NOT include METRICS_SCRAPE_TOKEN in the logged payload", () => {
    const logger = { info: vi.fn() };
    logStartupConfig(logger);
    const [payload] = logger.info.mock.calls[0] as [Record<string, unknown>];
    expect(payload).not.toHaveProperty("METRICS_SCRAPE_TOKEN");
    expect(payload).not.toHaveProperty("metricsToken");
  });

  it("logged appEnv matches live env.APP_ENV", () => {
    const logger = { info: vi.fn() };
    logStartupConfig(logger);
    const [payload] = logger.info.mock.calls[0] as [Record<string, unknown>];
    expect(payload["appEnv"]).toBe(env.APP_ENV);
  });

  it("logged port matches live env.PORT", () => {
    const logger = { info: vi.fn() };
    logStartupConfig(logger);
    const [payload] = logger.info.mock.calls[0] as [Record<string, unknown>];
    expect(payload["port"]).toBe(env.PORT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. APP_BASE_URL — present in schema, normalised, optional outside production
// ─────────────────────────────────────────────────────────────────────────────

describe("APP_BASE_URL", () => {
  it("is accessible on the env object without throwing (Zod v4 omits undefined optional keys)", () => {
    // Zod v4 does not include optional fields whose value is `undefined` as
    // enumerable keys in the parsed output object.  The correct invariant to
    // assert is that accessing the property never throws and yields either a
    // string (when set) or undefined (when unset) — not that `in` returns true.
    expect(() => env.APP_BASE_URL).not.toThrow();
    expect(env.APP_BASE_URL === undefined || typeof env.APP_BASE_URL === "string").toBe(true);
  });

  it("is present as a key on publicEnv", () => {
    expect("APP_BASE_URL" in publicEnv).toBe(true);
  });

  it("is NOT present on privateEnv", () => {
    expect("APP_BASE_URL" in privateEnv).toBe(false);
  });

  it("is undefined in the test environment (not set in env-setup.ts)", () => {
    // env-setup.ts does not set APP_BASE_URL — it should parse as undefined.
    expect(env.APP_BASE_URL).toBeUndefined();
  });

  it("optionalBaseUrl strips trailing slash from APP_BASE_URL when set", () => {
    const schema = z.preprocess(
      (val) =>
        typeof val === "string" && val.trim().length > 0
          ? normalizeUrl(val.trim())
          : undefined,
      z.string().url().optional(),
    );
    expect(schema.parse("https://fieldtrack.com/")).toBe(
      "https://fieldtrack.com",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. General env object invariants
// ─────────────────────────────────────────────────────────────────────────────

describe("env object — general invariants", () => {
  it("APP_ENV is one of the valid enum values", () => {
    expect(["development", "staging", "production", "test"]).toContain(
      env.APP_ENV,
    );
  });

  it("APP_ENV is 'test' in the test environment", () => {
    expect(env.APP_ENV).toBe("test");
  });

  it("SUPABASE_URL is a valid https URL", () => {
    expect(env.SUPABASE_URL).toMatch(/^https?:\/\/.+/);
  });

  it("REDIS_URL starts with redis:// or rediss://", () => {
    expect(env.REDIS_URL).toMatch(/^rediss?:\/\//);
  });

  it("SUPABASE_JWT_SECRET is at least 32 characters", () => {
    expect(env.SUPABASE_JWT_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it("TEMPO_ENDPOINT starts with http:// or https://", () => {
    expect(env.TEMPO_ENDPOINT).toMatch(/^https?:\/\//);
  });

  it("SERVICE_NAME is a non-empty string", () => {
    expect(env.SERVICE_NAME).toBeTruthy();
    expect(typeof env.SERVICE_NAME).toBe("string");
  });

  it("BODY_LIMIT_BYTES is a positive integer", () => {
    expect(Number.isInteger(env.BODY_LIMIT_BYTES)).toBe(true);
    expect(env.BODY_LIMIT_BYTES).toBeGreaterThan(0);
  });

  it("REQUEST_TIMEOUT_MS is a positive integer", () => {
    expect(Number.isInteger(env.REQUEST_TIMEOUT_MS)).toBe(true);
    expect(env.REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("WORKER_CONCURRENCY is a positive integer", () => {
    expect(Number.isInteger(env.WORKER_CONCURRENCY)).toBe(true);
    expect(env.WORKER_CONCURRENCY).toBeGreaterThanOrEqual(1);
  });
});
