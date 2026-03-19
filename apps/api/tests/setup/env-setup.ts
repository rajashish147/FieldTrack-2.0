/**
 * env-setup.ts — sets required environment variables before any project
 * module is imported. Vitest's setupFiles run as a side effect before each
 * test file, so assignments here take effect before env.ts processes them.
 *
 * APP_ENV=test must be set so that:
 *  1. The auth middleware uses @fastify/jwt instead of Supabase JWKS.
 *  2. Production-only safety checks (METRICS_SCRAPE_TOKEN, CORS_ORIGIN, etc.)
 *     are skipped by the Zod superRefine guards in env.ts.
 *  3. The Fastify app registers @fastify/jwt (see buildApp in app.ts).
 */
process.env["APP_ENV"] = "test";
process.env["NODE_ENV"] = "test";
process.env["PORT"] = "3001";
process.env["SUPABASE_URL"] = "https://placeholder.supabase.co";
process.env["SUPABASE_SERVICE_ROLE_KEY"] = "test-service-role-key-placeholder";
process.env["SUPABASE_ANON_KEY"] = "test-anon-key-placeholder";
// Minimum 32-char key for HMAC-SHA256 signing used by @fastify/jwt
process.env["SUPABASE_JWT_SECRET"] =
  "test-jwt-secret-long-enough-for-hs256-32chars!!";
process.env["REDIS_URL"] = "redis://localhost:6379";
// TEMPO_ENDPOINT must be set explicitly in tests because the schema default
// value ("http://tempo:4318") is validated at parse time. Without this, the
// Zod regex check runs on the default and fails in non-Docker environments
// where "tempo" does not resolve — explicitly setting it here keeps tests
// hermetic and independent of Docker network availability.
process.env["TEMPO_ENDPOINT"] = "http://localhost:4318";
// CORS_ORIGIN replaces the old ALLOWED_ORIGINS variable.
// In test mode the production non-empty check is skipped, so an empty string
// or a localhost value are both acceptable here.
process.env["CORS_ORIGIN"] = "http://localhost:3000";
