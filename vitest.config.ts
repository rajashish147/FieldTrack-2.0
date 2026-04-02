import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Run env-setup before every test file so required env vars are set
    // before any project module is imported.
    setupFiles: ["./tests/setup/env-setup.ts", "./tests/setup/mock-jwt-verifier.ts"],
    include: ["tests/**/*.test.ts"],
    // Reset mock call history (but not implementations) between tests.
    clearMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/server.ts",
        "src/tracing.ts",
        "src/types/**",
        "src/config/**",
      ],
    },
  },
});
