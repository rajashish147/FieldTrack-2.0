import { describe, it, expect } from "vitest";
import { shouldStartWorkers } from "../../../src/workers/startup.js";

describe("shouldStartWorkers()", () => {
  it("does not start workers when WORKERS_ENABLED is false", () => {
    expect(
      shouldStartWorkers({
        WORKERS_ENABLED: false,
        APP_ENV: "production",
      }),
    ).toBe(false);
  });

  it("does not start workers when WORKERS_ENABLED is not set (undefined → false)", () => {
    expect(
      shouldStartWorkers({
        WORKERS_ENABLED: undefined,
        APP_ENV: "production",
      }),
    ).toBe(false);
  });

  it("does not start workers in test environment even when WORKERS_ENABLED=true", () => {
    expect(
      shouldStartWorkers({
        WORKERS_ENABLED: true,
        APP_ENV: "test",
      }),
    ).toBe(false);
  });

  it("does not start workers when NODE_ENV=test", () => {
    expect(
      shouldStartWorkers({
        WORKERS_ENABLED: true,
        NODE_ENV: "test",
      }),
    ).toBe(false);
  });

  it("starts workers in production with WORKERS_ENABLED=true", () => {
    expect(
      shouldStartWorkers({
        WORKERS_ENABLED: true,
        APP_ENV: "production",
        NODE_ENV: "production",
      }),
    ).toBe(true);
  });

  it("starts workers in staging with WORKERS_ENABLED=true", () => {
    expect(
      shouldStartWorkers({
        WORKERS_ENABLED: true,
        APP_ENV: "staging",
        NODE_ENV: "production",
      }),
    ).toBe(true);
  });

  it("does not start workers in development without WORKERS_ENABLED", () => {
    expect(
      shouldStartWorkers({
        WORKERS_ENABLED: false,
        APP_ENV: "development",
      }),
    ).toBe(false);
  });
});
