/**
 * env-setup.ts — sets required environment variables before any project
 * module is imported. Vitest's setupFiles run as a side effect before each
 * test file, so assignments here take effect before env.ts processes them.
 *
 * APP_ENV=test skips production-only safety checks (METRICS_SCRAPE_TOKEN,
 * CORS_ORIGIN, etc.) in the Zod superRefine guards in env.ts.
 *
 * Supabase vars use ??= so that real values injected by GitHub Actions
 * (SUPABASE_URL_TEST etc.) are preserved when running in CI.
 */
process.env["APP_ENV"] = "test";
process.env["NODE_ENV"] = "test";
process.env["PORT"] = "3001";
process.env["SUPABASE_URL"] ??= "https://placeholder.supabase.co";
process.env["SUPABASE_SERVICE_ROLE_KEY"] ??= "test-service-role-key-placeholder";
process.env["SUPABASE_ANON_KEY"] ??= "test-anon-key-placeholder";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["TEMPO_ENDPOINT"] ??= "http://localhost:4318";
process.env["CORS_ORIGIN"] ??= "http://localhost:3000";
