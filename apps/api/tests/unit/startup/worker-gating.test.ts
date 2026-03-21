import { describe, it, expect } from "vitest";
import { shouldStartWorkers } from "../../../src/workers/startup.js";

describe("shouldStartWorkers()", () => {
  it("does not start workers in CI mode", () => {
    expect(
      shouldStartWorkers({
        CI_MODE: "true",
        SKIP_EXTERNAL_SERVICES: "false",
        NODE_ENV: "production",
      }),
    ).toBe(false);
  });

  it("does not start workers when external services are disabled", () => {
    expect(
      shouldStartWorkers({
        CI_MODE: "false",
        SKIP_EXTERNAL_SERVICES: "true",
        NODE_ENV: "production",
      }),
    ).toBe(false);
  });

  it("does not start workers in test environment", () => {
    expect(
      shouldStartWorkers({
        CI_MODE: "false",
        SKIP_EXTERNAL_SERVICES: "false",
        NODE_ENV: "test",
      }),
    ).toBe(false);
  });

  it("starts workers in production runtime", () => {
    expect(
      shouldStartWorkers({
        CI_MODE: "false",
        SKIP_EXTERNAL_SERVICES: "false",
        NODE_ENV: "production",
      }),
    ).toBe(true);
  });

  it("treats CI=1 as CI mode", () => {
    expect(
      shouldStartWorkers({
        CI: "1",
        SKIP_EXTERNAL_SERVICES: "false",
        NODE_ENV: "production",
      }),
    ).toBe(false);
  });

  it("treats APP_ENV=test as a no-worker runtime", () => {
    expect(
      shouldStartWorkers({
        CI_MODE: "false",
        SKIP_EXTERNAL_SERVICES: "false",
        APP_ENV: "test",
      }),
    ).toBe(false);
  });
});
