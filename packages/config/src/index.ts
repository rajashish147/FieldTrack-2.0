/**
 * @fieldtrack/config — Environment Contract for FieldTrack 2.0
 *
 * Single source of truth for ALL environment variable names, purposes,
 * and layer ownership across the entire monorepo.
 *
 * Layer model:
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  LAYER          │  VARIABLES                  │  SCOPE          │
 *   ├─────────────────┼─────────────────────────────┼─────────────────┤
 *   │  Backend (API)  │  API_BASE_URL               │  External URL   │
 *   │                 │  APP_BASE_URL               │  External URL   │
 *   │                 │  FRONTEND_BASE_URL          │  External URL   │
 *   │                 │  PORT, CORS_ORIGIN, …       │  Internal       │
 *   ├─────────────────┼─────────────────────────────┼─────────────────┤
 *   │  Frontend (web) │  NEXT_PUBLIC_API_BASE_URL   │  External URL   │
 *   │                 │  NEXT_PUBLIC_SUPABASE_URL   │  External URL   │
 *   │                 │  NEXT_PUBLIC_SUPABASE_ANON_KEY               │
 *   │                 │  NEXT_PUBLIC_MAPBOX_TOKEN   │  Client-side    │
 *   ├─────────────────┼─────────────────────────────┼─────────────────┤
 *   │  CI / Scripts   │  API_BASE_URL               │  External URL   │
 *   │                 │  CORS_ORIGIN                │  Deploy config  │
 *   ├─────────────────┼─────────────────────────────┼─────────────────┤
 *   │  Infra          │  API_HOSTNAME               │  Domain only    │
 *   │                 │  FRONTEND_DOMAIN            │  Domain only    │
 *   │                 │  METRICS_SCRAPE_TOKEN       │  Security       │
 *   │                 │  GRAFANA_ADMIN_PASSWORD     │  Security       │
 *   └─────────────────┴─────────────────────────────┴─────────────────┘
 *
 * Naming rules (MUST be enforced across all layers):
 *
 *   1. Variables ending in _BASE_URL hold a full URL (scheme + host, no path).
 *      Example: https://api.getfieldtrack.app
 *
 *   2. Variables ending in _HOSTNAME hold a bare domain with no scheme or path.
 *      Example: api.getfieldtrack.app
 *
 *   3. NEXT_PUBLIC_* prefix is reserved for Next.js browser-exposed variables.
 *
 *   4. API_BASE_URL is the canonical external API URL used by all layers.
 *      - Backend:  loaded from .env, required in production
 *      - Scripts:  exported by load-env.sh, used by smoke-test.sh
 *      - CI:       passed as GitHub secret API_BASE_URL
 *
 *   5. API_HOSTNAME is always DERIVED from API_BASE_URL at deploy-time.
 *      It MUST NOT be set directly in apps/api/.env.
 *
 *   6. The frontend uses NEXT_PUBLIC_API_BASE_URL (not API_BASE_URL) because
 *      Next.js bakes NEXT_PUBLIC_* at build time via static replacement.
 *
 * Usage:
 *   import { ENV_VARS, EnvLayerContract } from "@fieldtrack/config";
 */

import { z } from "zod";

// ─── Shared URL schema primitive ──────────────────────────────────────────────

/**
 * Zod schema for an optional base URL.
 * Strips trailing slashes and validates http(s):// format.
 * Accepts undefined / empty string as "not set".
 */
export const optionalBaseUrl = z.preprocess(
  (val) =>
    typeof val === "string" && val.trim().length > 0
      ? val.trim().replace(/\/+$/, "")
      : undefined,
  z.string().url().optional(),
);

/**
 * Zod schema for a required base URL.
 */
export const requiredBaseUrl = z.string().url();

// ─── Layer-specific type contracts ────────────────────────────────────────────

/**
 * Backend API environment contract (apps/api).
 *
 * All variables validated by apps/api/src/config/env.ts.
 * This interface is the canonical type reference.
 */
export interface BackendEnvContract {
  // Runtime
  APP_ENV: "development" | "staging" | "production" | "test";
  NODE_ENV: string;
  PORT: number;

  // External URLs (full URL, no trailing slash)
  APP_BASE_URL?: string;      // Canonical app URL for link generation
  API_BASE_URL?: string;      // This API's public URL (EXTERNAL)
  FRONTEND_BASE_URL?: string; // Frontend URL for email links (EXTERNAL)

  // CORS
  CORS_ORIGIN: string;

  // Supabase
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  // Redis
  REDIS_URL: string;

  // Security
  METRICS_SCRAPE_TOKEN?: string;

  // Observability
  TEMPO_ENDPOINT: string;
  SERVICE_NAME: string;
  GITHUB_SHA?: string;

  // Limits
  BODY_LIMIT_BYTES: number;
  REQUEST_TIMEOUT_MS: number;
  MAX_QUEUE_DEPTH: number;
  MAX_POINTS_PER_SESSION: number;
  MAX_SESSION_DURATION_HOURS: number;
  WORKER_CONCURRENCY: number;
  ANALYTICS_WORKER_CONCURRENCY: number;

  // Infrastructure availability
  WORKERS_ENABLED: boolean;
}

/**
 * Frontend environment contract (apps/web).
 *
 * All variables validated by apps/web/src/lib/env.ts.
 * NEXT_PUBLIC_* variables are baked in at Next.js build time.
 */
export interface FrontendEnvContract {
  // The public URL of the backend API — full URL or root-relative proxy path.
  // Full URL:  https://api.getfieldtrack.app  (browser calls API directly)
  // Relative:  /api/proxy                     (browser routes via Next.js proxy)
  NEXT_PUBLIC_API_BASE_URL: string;

  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
  NEXT_PUBLIC_MAPBOX_TOKEN: string;
}

/**
 * Infra monitoring environment contract (infra/.env.monitoring).
 *
 * Used by Docker Compose for Prometheus, Grafana, Nginx, Blackbox.
 */
export interface InfraEnvContract {
  // Domain only — no scheme, no path. Derived from API_BASE_URL.
  // Example: api.getfieldtrack.app
  API_HOSTNAME: string;

  // Domain only for the frontend application.
  // Example: app.getfieldtrack.app
  FRONTEND_DOMAIN: string;

  GRAFANA_ADMIN_PASSWORD: string;

  // MUST match METRICS_SCRAPE_TOKEN in apps/api/.env
  METRICS_SCRAPE_TOKEN: string;
}

/**
 * CI / script environment contract.
 *
 * Variables consumed by deploy scripts, smoke tests, and GitHub Actions.
 * Stored as GitHub repository secrets.
 */
export interface CIEnvContract {
  // Full public URL of the API used for health probes and smoke tests.
  // GitHub secret: API_BASE_URL
  // Example: https://api.getfieldtrack.app
  API_BASE_URL: string;

  // Allowed CORS origins passed to the deployed container.
  // GitHub secret: CORS_ORIGIN
  CORS_ORIGIN: string;

  // SSH deployment credentials
  DO_HOST: string;
  DO_USER: string;
  DO_SSH_KEY: string;

  // Smoke test credentials
  FT_EMP_EMAIL: string;
  FT_EMP_PASSWORD: string;
  FT_ADMIN_EMAIL: string;
  FT_ADMIN_PASSWORD: string;

  // Supabase (for smoke test auth)
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

// ─── ENV_VARS registry ────────────────────────────────────────────────────────

/**
 * Registry of ALL environment variable names across all layers.
 *
 * Use these constants instead of bare strings to avoid typos.
 *
 * @example
 *   import { ENV_VARS } from "@fieldtrack/config";
 *   const url = process.env[ENV_VARS.API_BASE_URL];
 */
export const ENV_VARS = {
  // ── Backend / CI shared ────────────────────────────────────────────────────
  API_BASE_URL:       "API_BASE_URL",
  APP_BASE_URL:       "APP_BASE_URL",
  FRONTEND_BASE_URL:  "FRONTEND_BASE_URL",
  CORS_ORIGIN:        "CORS_ORIGIN",

  // ── Backend only ──────────────────────────────────────────────────────────
  APP_ENV:                      "APP_ENV",
  NODE_ENV:                     "NODE_ENV",
  PORT:                         "PORT",
  CONFIG_VERSION:               "CONFIG_VERSION",
  SUPABASE_URL:                 "SUPABASE_URL",
  SUPABASE_ANON_KEY:            "SUPABASE_ANON_KEY",
  SUPABASE_SERVICE_ROLE_KEY:    "SUPABASE_SERVICE_ROLE_KEY",
  REDIS_URL:                    "REDIS_URL",
  METRICS_SCRAPE_TOKEN:         "METRICS_SCRAPE_TOKEN",
  TEMPO_ENDPOINT:               "TEMPO_ENDPOINT",
  SERVICE_NAME:                 "SERVICE_NAME",
  GITHUB_SHA:                   "GITHUB_SHA",
  BODY_LIMIT_BYTES:             "BODY_LIMIT_BYTES",
  REQUEST_TIMEOUT_MS:           "REQUEST_TIMEOUT_MS",
  MAX_QUEUE_DEPTH:              "MAX_QUEUE_DEPTH",
  MAX_POINTS_PER_SESSION:       "MAX_POINTS_PER_SESSION",
  MAX_SESSION_DURATION_HOURS:   "MAX_SESSION_DURATION_HOURS",
  WORKER_CONCURRENCY:           "WORKER_CONCURRENCY",
  ANALYTICS_WORKER_CONCURRENCY: "ANALYTICS_WORKER_CONCURRENCY",
  WORKERS_ENABLED:              "WORKERS_ENABLED",

  // ── Frontend (NEXT_PUBLIC_*) ───────────────────────────────────────────────
  NEXT_PUBLIC_API_BASE_URL:      "NEXT_PUBLIC_API_BASE_URL",
  NEXT_PUBLIC_SUPABASE_URL:      "NEXT_PUBLIC_SUPABASE_URL",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  NEXT_PUBLIC_MAPBOX_TOKEN:      "NEXT_PUBLIC_MAPBOX_TOKEN",

  // ── Infra-only ────────────────────────────────────────────────────────────
  API_HOSTNAME:            "API_HOSTNAME",
  FRONTEND_DOMAIN:         "FRONTEND_DOMAIN",
  GRAFANA_ADMIN_PASSWORD:  "GRAFANA_ADMIN_PASSWORD",
} as const;

export type EnvVarName = (typeof ENV_VARS)[keyof typeof ENV_VARS];
