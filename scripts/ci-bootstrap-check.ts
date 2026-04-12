const bootstrapEnvDefaults: Record<string, string> = {
  CONFIG_VERSION: "1",
  APP_ENV: "ci",
  NODE_ENV: "production",
  PORT: "3000",
  APP_BASE_URL: "http://localhost:3000",
  API_BASE_URL: "http://localhost:3000",
  FRONTEND_BASE_URL: "http://localhost:3000",
  CORS_ORIGIN: "http://localhost:3000",
  REDIS_URL: "redis://invalid-ci-host:6379",
  WORKERS_ENABLED: "false",
  METRICS_SCRAPE_TOKEN: "dummy",
  SUPABASE_URL: "https://ci-bootstrap.supabase.co",
  SUPABASE_ANON_KEY: "ci-bootstrap-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "ci-bootstrap-service-role-key",
};

for (const [key, value] of Object.entries(bootstrapEnvDefaults)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

async function main(): Promise<void> {
  const { buildApp } = await import("../src/app.js");
  const app = await buildApp();
  try {
    await app.ready();
    app.log.info("CI bootstrap check passed: Fastify app initialized cleanly");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error("CI bootstrap check failed", error);
  process.exit(1);
});
