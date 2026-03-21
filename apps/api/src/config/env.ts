/**
 * env.ts — Centralized, Zod-validated environment configuration for FieldTrack 2.0.
 *
 * ALL environment-specific values must flow through this module.
 * Direct `process.env` access is forbidden everywhere else in the codebase.
 *
 * Design rules:
 *  1. Schema validation at process startup — any missing or invalid variable
 *     throws immediately with a clear, actionable error message (fail fast).
 *  2. APP_ENV is the canonical application-level environment token.
 *     NODE_ENV is preserved for Node.js/npm ecosystem compatibility only.
 *  3. Every config value has a type, a default (where safe), and a comment
 *     explaining its purpose and expected format.
 *  4. Production-only safety constraints are enforced via superRefine so they
 *     are part of the schema contract, not scattered across the codebase.
 *  5. URL fields are normalised at parse time (trailing slashes stripped) to
 *     prevent double-slash bugs when concatenating path segments.
 *  6. publicEnv / privateEnv split prevents accidental secret exposure in any
 *     future frontend-facing serialisation path.
 *
 * Usage:
 *   import { env }                            from "../config/env.js";
 *   import { env, corsOrigins }               from "../config/env.js";
 *   import { publicEnv, logStartupConfig }    from "../config/env.js";
 */

import { z } from "zod";
import dotenv from "dotenv";
import { createHash } from "crypto";
import { normalizeUrl } from "../utils/url.js";

// Load .env file — no-op in Docker where env vars are injected at runtime.
dotenv.config();

// ─── Reusable field builders ───────────────────────────────────────────────────
//
// These helpers centralise the "optional URL that is normalised on parse"
// pattern so each URL field is defined once without repetition.

/**
 * Zod schema for an optional base URL.
 * Validates HTTPS/HTTP format and strips trailing slashes at parse time.
 * Yields `string | undefined` — undefined when the env var is unset or empty.
 */
const optionalBaseUrl = z.preprocess(
  // Convert empty strings to undefined so the optional() branch fires
  // correctly.  Operators sometimes set VAR="" to "unset" a variable.
  (val) =>
    typeof val === "string" && val.trim().length > 0
      ? normalizeUrl(val.trim())
      : undefined,
  z.string().url().optional(),
);

// ─── Schema ───────────────────────────────────────────────────────────────────

const envSchema = z
  .object({
    // ── Config versioning ─────────────────────────────────────────────────────

    /**
     * Explicit configuration schema version.
     *
     * Set to the literal string "1" in every .env / secrets manager entry.
     * When this project increments the schema (breaking change), bump the
     * expected literal here and in CI/CD.  Deployments carrying a stale
     * CONFIG_VERSION will fail fast rather than misbehave silently.
     *
     * Value: must be the exact string "1" — any other value fails validation.
     * Default: "1" (so existing deployments without the variable are unaffected).
     */
    CONFIG_VERSION: z.literal("1").default("1"),

    // ── Runtime environment ───────────────────────────────────────────────────

    /**
     * Canonical application environment.
     *
     * Drive ALL application-level logic from this variable.
     * Never use NODE_ENV for feature flags, route guards, or behaviour changes.
     *
     * Falls back to NODE_ENV for backward compatibility with existing deployments
     * that only set NODE_ENV (e.g. the Dockerfile bakes NODE_ENV=production).
     *
     * Valid values: development | staging | production | test
     */
    APP_ENV: z.preprocess(
      (val) =>
        val !== undefined && val !== ""
          ? val
          : (process.env["NODE_ENV"] ?? "development"),
      z.enum(["development", "staging", "production", "test"]),
    ),

    /**
     * Standard Node.js environment variable.
     *
     * Kept for npm/library ecosystem compatibility (Fastify, pino, etc.).
     * Do NOT use this for application-level environment checks — use APP_ENV.
     */
    NODE_ENV: z.string().default("development"),

    /**
     * TCP port the Fastify server listens on inside the container.
     * Docker host mapping is handled externally (e.g. -p 3000:3000).
     *
     * Range: 1000–65535.  Ports below 1000 require root privileges and are
     * not appropriate for a containerised Node.js process.
     */
    PORT: z.coerce.number().int().min(1000).max(65535).default(3000),

    // ── Application URLs ──────────────────────────────────────────────────────
    //
    // All URL fields are processed by optionalBaseUrl, which:
    //   • Strips trailing slashes  → prevents "https://host//path" bugs.
    //   • Coerces empty strings to undefined  → optional() fires correctly.
    //   • Validates URL format via z.string().url().

    /**
     * Canonical base URL for the entire application.
     *
     * Use this as the single source of truth for generating absolute links
     * anywhere that does not need to distinguish between API and frontend
     * (e.g. email footers, canonical <link> headers, generic redirects).
     *
     * Required in production — startup fails if absent when APP_ENV=production.
     *
     * Format: full URL including protocol, no trailing slash.
     * Example: https://fieldtrack.com
     */
    APP_BASE_URL: optionalBaseUrl,

    /**
     * Fully-qualified base URL of this API service.
     *
     * Used in:
     *   - OpenAPI server definitions (so Swagger UI points to the right server)
     *   - Any server-generated links that reference the API itself
     *
     * Required in production — startup fails if absent when APP_ENV=production.
     *
     * Format: full URL including protocol, no trailing slash.
     * Example: https://api.fieldtrack.com
     */
    API_BASE_URL: optionalBaseUrl,

    /**
     * Fully-qualified base URL of the frontend application.
     *
     * Used in:
     *   - Password-reset email links:  ${FRONTEND_BASE_URL}/reset-password?token=…
     *   - Invitation email links:      ${FRONTEND_BASE_URL}/accept-invite?token=…
     *   - Any server-generated redirect that lands the user in the UI
     *
     * Required in production — startup fails if absent when APP_ENV=production.
     *
     * Format: full URL including protocol, no trailing slash.
     * Example: https://app.fieldtrack.com
     */
    FRONTEND_BASE_URL: optionalBaseUrl,

    // ── CORS ──────────────────────────────────────────────────────────────────

    /**
     * Comma-separated list of origins permitted by the CORS policy.
     *
     * In development: when left empty, the CORS plugin falls back to a
     * hardcoded safe list of local development origins (localhost:3000 and
     * localhost:5173).  Wildcard origin (`true`) is never used.
     *
     * In production: must be explicitly set — startup fails if empty.
     *
     * Examples:
     *   Single origin:   https://app.fieldtrack.com
     *   Multiple:        https://app.fieldtrack.com,https://admin.fieldtrack.com
     */
    CORS_ORIGIN: z.string().default(""),

    // ── Supabase ──────────────────────────────────────────────────────────────

    /**
     * Supabase project URL.
     * Example: https://xyzcompany.supabase.co
     */
    SUPABASE_URL: z.string().url(),

    /**
     * Supabase anonymous (public) key.
     * Safe to expose to browsers. Subject to Row Level Security.
     */
    SUPABASE_ANON_KEY: z.string().min(1),

    /**
     * Supabase service role key.
     * NEVER expose this to clients. Bypasses Row Level Security.
     * Used exclusively by the backend for privileged database operations.
     */
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

    /**
     * Supabase JWT signing secret (HS256).
     * Used by @fastify/jwt in test mode to sign and verify test tokens.
     * Must be at least 32 characters for HMAC-SHA256 security.
     */
    SUPABASE_JWT_SECRET: z
      .string()
      .min(32, "SUPABASE_JWT_SECRET must be at least 32 characters"),

    // ── Redis ─────────────────────────────────────────────────────────────────

    /**
     * Full Redis connection URL used by BullMQ workers and the rate-limit store.
     *
     * redis://   — plain TCP (local/private network)
     * rediss://  — TLS-encrypted (managed Redis, e.g. Redis Cloud, Upstash)
     *
     * Examples:
     *   redis://redis:6379
     *   redis://:password@redis.example.com:6379
     *   rediss://user:password@redis-tls.example.com:6380
     */
    REDIS_URL: z
      .string()
      .regex(
        /^rediss?:\/\//,
        "REDIS_URL must begin with redis:// or rediss://. Example: redis://redis:6379",
      ),

    // ── Security ──────────────────────────────────────────────────────────────

    /**
     * Bearer token that Prometheus must present to scrape /metrics.
     *
     * When set, the /metrics endpoint requires:
     *   Authorization: Bearer <METRICS_SCRAPE_TOKEN>
     *
     * When unset (development/test), /metrics is open for convenience.
     * MUST be set in production — startup fails if it is missing there.
     */
    METRICS_SCRAPE_TOKEN: z.string().min(1).optional(),

    // ── Observability ─────────────────────────────────────────────────────────

    /**
     * OTLP HTTP endpoint for exporting traces to Grafana Tempo.
     *
     * Default resolves via Docker service name on fieldtrack_network.
     * Override for non-Docker deployments, external Tempo, or cloud OTLP ingest.
     *
     * Note: bare Docker service hostnames (e.g. "tempo") are intentionally
     * accepted — z.string().url() rejects them because they lack a TLD, so we
     * use a lightweight protocol-prefix check instead.
     *
     * Examples:
     *   Docker (default): http://tempo:4318
     *   External Tempo:   https://tempo.example.com:4318
     *   Grafana Cloud:    https://otlp-gateway-prod-eu-west-0.grafana.net/otlp
     */
    TEMPO_ENDPOINT: z
      .string()
      .regex(
        /^https?:\/\/.+/,
        "TEMPO_ENDPOINT must start with http:// or https://. " +
          "Example: http://tempo:4318",
      )
      .default("http://tempo:4318"),

    /**
     * OpenTelemetry service name.
     * Appears as the service label in Grafana Tempo / service graph.
     * Change per deployment if running multiple environments in one Tempo instance.
     */
    SERVICE_NAME: z.string().default("fieldtrack-backend"),

    /**
     * Git commit SHA injected by GitHub Actions.
     * Logged on server boot to correlate a running container to a git commit.
     * Optional — falls back to "manual" when not running in CI.
     */
    GITHUB_SHA: z.string().optional(),

    // ── HTTP limits ───────────────────────────────────────────────────────────

    /**
     * Maximum allowed request body size in bytes.
     * Protects against large-payload denial-of-service attacks.
     * Default: 1 MB (1_000_000 bytes)
     */
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_000_000),

    /**
     * Maximum time in milliseconds Fastify waits for a response before closing
     * the connection. Prevents slow-response resource exhaustion.
     * Default: 30 seconds
     */
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

    // ── Worker limits ─────────────────────────────────────────────────────────

    /**
     * Maximum number of distance-recalculation jobs that may wait in the
     * BullMQ queue before new enqueues are rejected.
     * Guards against runaway session creation flooding Redis.
     */
    MAX_QUEUE_DEPTH: z.coerce.number().int().positive().default(1_000),

    /**
     * Maximum GPS point count per session before the recalculation job is
     * rejected. Guards against pathological data saturating the event loop.
     */
    MAX_POINTS_PER_SESSION: z.coerce.number().int().positive().default(50_000),

    /**
     * Sessions longer than this many hours are treated as data-integrity
     * anomalies and skipped during recalculation (e.g. an un-closed dev session).
     * Default: 168 h (7 days)
     */
    MAX_SESSION_DURATION_HOURS: z.coerce
      .number()
      .int()
      .positive()
      .default(168),

    /**
     * Number of distance recalculation jobs the distance worker processes
     * concurrently per replica. Default 1 ensures sequential, predictable
     * processing. Increase for horizontal scaling.
     */
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),

    /**
     * Number of analytics aggregation jobs the analytics worker processes
     * concurrently per replica.
     *
     * Range: 1–50.
     *   - Lower values reduce database connection pressure but slow post-checkout
     *     metric aggregation under load.
     *   - Values above 50 are unlikely to help — the bottleneck shifts to the
     *     database at that point and risks overwhelming the connection pool.
     *
     * Default: 5
     */
    ANALYTICS_WORKER_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1, "ANALYTICS_WORKER_CONCURRENCY must be at least 1")
      .max(50, "ANALYTICS_WORKER_CONCURRENCY must be at most 50 (database pressure above this is counterproductive)")
      .default(5),
  })

  // ─── Production-only safety constraints ────────────────────────────────────
  //
  // These checks run AFTER field-level validation so error messages can
  // reference other already-validated fields. Each issue is attached to the
  // specific path that needs fixing so operators know exactly what to set.
  .superRefine((data, ctx) => {
    const isProd = data.APP_ENV === "production";

    // 1. /metrics must be token-protected in production.
    if (isProd && !data.METRICS_SCRAPE_TOKEN) {
      ctx.addIssue({
        code: "custom",
        path: ["METRICS_SCRAPE_TOKEN"],
        message:
          "METRICS_SCRAPE_TOKEN must be set in production to protect the " +
          "/metrics endpoint from unauthenticated scraping.",
      });
    }

    // 2. Open CORS in production leaks credentials to any origin.
    if (isProd && !data.CORS_ORIGIN.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["CORS_ORIGIN"],
        message:
          "CORS_ORIGIN must be set in production. An empty value causes the " +
          "CORS plugin to allow all origins, opening the API to cross-site " +
          "credential abuse. Example: https://app.fieldtrack.com",
      });
    }

    // 3. APP_BASE_URL is the canonical root for all absolute link generation.
    if (isProd && !data.APP_BASE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_BASE_URL"],
        message:
          "APP_BASE_URL must be set in production. It is the canonical base " +
          "URL for generating absolute links (emails, redirects, OpenGraph). " +
          "Example: https://fieldtrack.com",
      });
    }

    // 4. API_BASE_URL is needed for accurate OpenAPI documentation and any
    //    server-generated absolute links that reference the API itself.
    if (isProd && !data.API_BASE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["API_BASE_URL"],
        message:
          "API_BASE_URL must be set in production so that the OpenAPI " +
          "specification and server-generated API links point to the correct " +
          "host. Example: https://api.fieldtrack.com",
      });
    }

    // 5. FRONTEND_BASE_URL is required in production for email link generation.
    //    Reset-password and invitation emails become broken without it.
    if (isProd && !data.FRONTEND_BASE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["FRONTEND_BASE_URL"],
        message:
          "FRONTEND_BASE_URL must be set in production. It is used to build " +
          "password-reset and invitation links in outbound emails. " +
          "Example: https://app.fieldtrack.com",
      });
    }
  });

// ─── Type export ──────────────────────────────────────────────────────────────

export type EnvConfig = z.infer<typeof envSchema>;

// ─── Parse & validate ─────────────────────────────────────────────────────────

function parseEnv(): EnvConfig {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    // Format every validation issue as a clearly indented list so operators
    // can scan and fix the .env / secrets store in one pass.
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "root";
        return `  • [${path}] ${issue.message}`;
      })
      .join("\n");

    // Throw synchronously — this runs at import time, which is intentional.
    // A misconfigured container should exit immediately rather than serve
    // partial traffic with broken behaviour.
    throw new Error(
      `\n\n❌  Environment validation failed — the server will not start.\n` +
        `   Fix the following variable(s) before retrying:\n\n` +
        `${issues}\n`,
    );
  }

  return result.data;
}

// ─── Lazy singleton ───────────────────────────────────────────────────────────
//
// Validation is deferred to the first property access on `env` rather than
// running at import time.  This eliminates module-level side-effects so that
// importing env.ts in tests or CI tooling no longer crashes when env vars
// are absent.  Production safety is preserved: any code path that reads
// `env.PORT`, `env.SUPABASE_URL`, etc. will trigger parseEnv() and fail
// immediately if the environment is misconfigured.

let _envCache: EnvConfig | undefined;

export function getEnv(): EnvConfig {
  if (!_envCache) {
    _envCache = Object.freeze(parseEnv());
  }
  return _envCache;
}

/**
 * Validated environment configuration.
 *
 * Backed by a Proxy so that validation runs lazily on first property access
 * rather than at module import time.  All existing `env.PORT`, `env.APP_ENV`
 * consumers work unchanged.
 */
export const env: EnvConfig = new Proxy({} as EnvConfig, {
  get(_target, prop, receiver) {
    return Reflect.get(getEnv(), prop, receiver);
  },
  has(_target, prop) {
    return prop in getEnv();
  },
  ownKeys() {
    return Reflect.ownKeys(getEnv());
  },
  getOwnPropertyDescriptor(_target, prop) {
    const e = getEnv();
    if (prop in e) {
      return {
        configurable: true,
        enumerable: true,
        value: (e as Record<string | symbol, unknown>)[prop],
      };
    }
    return undefined;
  },
});

// ─── Derived helpers ──────────────────────────────────────────────────────────

/**
 * Parsed, trimmed list of allowed CORS origins.
 * Lazy — computed on first call and cached.
 */
let _corsOriginsCache: string[] | undefined;
export function getCorsOrigins(): string[] {
  if (!_corsOriginsCache) {
    _corsOriginsCache = env.CORS_ORIGIN.split(",")
      .map((o) => o.trim())
      .filter(Boolean);
  }
  return _corsOriginsCache;
}

// ─── Public / private config split ────────────────────────────────────────────
//
// These typed subsets enforce an explicit boundary between values that are
// safe to surface (e.g. in API responses, logs, health endpoints) and values
// that must NEVER leave the server process.
//
// Rule: any code path that could serialise config to a client (frontend SDK,
// API response, SSE event) should import publicEnv, never env directly.

/**
 * Safe-to-expose configuration values.
 * Lazy — reads from the env proxy on first call.
 */
export function getPublicEnv() {
  return {
    CONFIG_VERSION: env.CONFIG_VERSION,
    APP_ENV:        env.APP_ENV,
    PORT:           env.PORT,
    APP_BASE_URL:   env.APP_BASE_URL,
    API_BASE_URL:   env.API_BASE_URL,
    FRONTEND_BASE_URL: env.FRONTEND_BASE_URL,
    SERVICE_NAME:   env.SERVICE_NAME,
    GITHUB_SHA:     env.GITHUB_SHA,
  } as const;
}

export type PublicEnvConfig = ReturnType<typeof getPublicEnv>;

/**
 * Secret configuration values that must NEVER be serialised or forwarded.
 * Lazy — reads from the env proxy on first call.
 */
export function getPrivateEnv() {
  return {
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_JWT_SECRET:       env.SUPABASE_JWT_SECRET,
    METRICS_SCRAPE_TOKEN:      env.METRICS_SCRAPE_TOKEN,
    REDIS_URL:                 env.REDIS_URL,
  } as const;
}

export type PrivateEnvConfig = ReturnType<typeof getPrivateEnv>;

let _configHashCache: string | undefined;

/**
 * Stable short fingerprint of deployment-relevant configuration values.
 * Useful for detecting drift across replicas.
 */
export function getConfigHash(): string {
  if (!_configHashCache) {
    _configHashCache = createHash("sha256")
      .update(
        JSON.stringify({
          configVersion: env.CONFIG_VERSION,
          appEnv:        env.APP_ENV,
          port:          env.PORT,
          appBaseUrl:    env.APP_BASE_URL      ?? "",
          apiBaseUrl:    env.API_BASE_URL      ?? "",
          frontendUrl:   env.FRONTEND_BASE_URL ?? "",
          serviceName:   env.SERVICE_NAME,
          corsOrigin:    env.CORS_ORIGIN,
        }),
      )
      .digest("hex")
      .slice(0, 12);
  }
  return _configHashCache;
}

// ─── Startup config log ───────────────────────────────────────────────────────

/**
 * Minimal logger interface accepted by logStartupConfig.
 *
 * Matches the subset of FastifyBaseLogger actually used here so callers do not
 * need to import Fastify types just to call this function.
 */
interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Emit a structured startup log of all safe, deployment-relevant config values.
 *
 * Call this once, immediately after `app.listen()` resolves in server.ts.
 *
 * What it logs (publicEnv + operational fields):
 *   - CONFIG_VERSION   — schema version for deployment mismatch detection
 *   - APP_ENV          — environment sanity check
 *   - PORT             — what the server is actually listening on
 *   - APP_BASE_URL     — canonical root URL
 *   - API_BASE_URL     — API surface URL
 *   - FRONTEND_BASE_URL — frontend URL used in generated links
 *   - SERVICE_NAME     — otel service label
 *   - GITHUB_SHA       — deployed commit (CI deployments only)
 *   - CORS_ORIGIN      — active CORS policy summary
 *   - TEMPO_ENDPOINT   — tracing export destination
 *
 * What it deliberately omits (secrets):
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - SUPABASE_JWT_SECRET
 *   - METRICS_SCRAPE_TOKEN
 *   - REDIS_URL  (may contain a password in the connection string)
 *   - SUPABASE_ANON_KEY / SUPABASE_URL (not needed for deployment verification)
 *
 * @param logger - Any logger with an `info(obj, msg)` method (e.g. app.log).
 */
export function logStartupConfig(logger: MinimalLogger): void {
  const configHash = getConfigHash();

  logger.info(
    {
      // ── Identity ───────────────────────────────────────────────────────────
      configVersion: env.CONFIG_VERSION,
      appEnv:        env.APP_ENV,
      port:          env.PORT,
      serviceName:   env.SERVICE_NAME,
      commitSha:     env.GITHUB_SHA ?? "manual",

      // ── URLs (safe — no credentials) ──────────────────────────────────────
      appBaseUrl:      env.APP_BASE_URL      ?? "(unset)",
      apiBaseUrl:      env.API_BASE_URL      ?? "(unset)",
      // Bare hostname derived from apiBaseUrl — matches the API_HOSTNAME used
      // by nginx, Prometheus, load-env.sh, and infra scripts. Logged here for
      // cross-checking: if this value differs from infra/.env.monitoring, the
      // env contract is violated and deployment will fail validation.
      apiHostname:     env.API_BASE_URL      ? new URL(env.API_BASE_URL).host : "(unset)",
      frontendBaseUrl: env.FRONTEND_BASE_URL ?? "(unset)",

      // ── Operational ───────────────────────────────────────────────────────
      corsOrigin:    env.CORS_ORIGIN || "(unset — dev origins active)",
      tempoEndpoint: env.TEMPO_ENDPOINT,

      // ── Drift detection ───────────────────────────────────────────────────
      // Compare this value across all replicas in Grafana/Loki.  If two
      // running instances show different hashes, their configs have drifted.
      configHash,
    },
    "startup:config",
  );

  // Domain pattern warning — surfaces misconfigured deployments (e.g.
  // a staging URL accidentally used in production) without blocking startup.
  // Only fires when APP_ENV=production so local/staging noise is suppressed.
  if (env.APP_ENV === "production" && env.API_BASE_URL) {
    const knownProdPattern = /^https:\/\/[^/]+\.[^/]+/;
    const isHttp = env.API_BASE_URL.startsWith("http://");
    const isLocalhost = env.API_BASE_URL.includes("localhost") || env.API_BASE_URL.includes("127.0.0.1");
    if (isHttp || isLocalhost || !knownProdPattern.test(env.API_BASE_URL)) {
      logger.info(
        {
          apiBaseUrl: env.API_BASE_URL,
          warning:
            "API_BASE_URL does not look like a production HTTPS URL. " +
            "Verify this is intentional before serving real traffic.",
        },
        "startup:config:warning",
      );
    }
  }
}
