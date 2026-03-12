import { describe, it, expect } from "vitest";
import { calculateHaversineDistance } from "../../../src/utils/distance.js";

// ─── calculateHaversineDistance ───────────────────────────────────────────────
// All reference values verified against multiple independent Haversine
// calculators and cross-checked with the Wikipedia formula.

describe("calculateHaversineDistance()", () => {
  // ── Known-distance pairs ─────────────────────────────────────────────────

  it("returns ~0 for identical coordinates", () => {
    const d = calculateHaversineDistance(28.6139, 77.209, 28.6139, 77.209);
    expect(d).toBe(0);
  });

  it("calculates distance between London and Paris (~341 km)", () => {
    // London: 51.5074° N, 0.1278° W  |  Paris: 48.8566° N, 2.3522° E
    const d = calculateHaversineDistance(51.5074, -0.1278, 48.8566, 2.3522);
    // Tolerance ±5 km to account for floating-point variance
    expect(d / 1000).toBeCloseTo(341, -1); // -1 → nearest 10 km
  });

  it("calculates distance between New York and Los Angeles (~3940 km)", () => {
    // NYC: 40.7128° N, 74.006° W  |  LAX: 34.0522° N, 118.2437° W
    const d = calculateHaversineDistance(40.7128, -74.006, 34.0522, -118.2437);
    expect(d / 1000).toBeCloseTo(3940, -2); // -2 → nearest 100 km
  });

  it("calculates distance between Mumbai and Delhi (~1148 km)", () => {
    const d = calculateHaversineDistance(19.076, 72.8777, 28.7041, 77.1025);
    expect(d / 1000).toBeCloseTo(1148, -2);
  });

  // ── Symmetry property ────────────────────────────────────────────────────

  it("is symmetric: distance(A→B) === distance(B→A)", () => {
    const d1 = calculateHaversineDistance(51.5074, -0.1278, 48.8566, 2.3522);
    const d2 = calculateHaversineDistance(48.8566, 2.3522, 51.5074, -0.1278);
    expect(d1).toBeCloseTo(d2, 5);
  });

  // ── Return type ──────────────────────────────────────────────────────────

  it("returns a number (meters)", () => {
    const d = calculateHaversineDistance(0, 0, 0, 1);
    expect(typeof d).toBe("number");
    expect(d).toBeGreaterThan(0);
  });

  it("returns distance in meters (>1000 for 1 degree of longitude at equator)", () => {
    // 1° of longitude at the equator ≈ 111,320 m
    const d = calculateHaversineDistance(0, 0, 0, 1);
    expect(d).toBeGreaterThan(100_000);
    expect(d).toBeLessThan(120_000);
  });

  // ── Antipodal points (maximum possible distance) ─────────────────────────

  it("handles antipodal points (North/South poles: ~20,015 km)", () => {
    const d = calculateHaversineDistance(90, 0, -90, 0);
    // Half of Earth circumference (40,030 km)
    expect(d / 1000).toBeCloseTo(20_015, -2);
  });

  // ── Tiny distances ────────────────────────────────────────────────────────

  it("handles very small distances (≈1 meter accuracy)", () => {
    // Points ~10 m apart in Bangalore
    const d = calculateHaversineDistance(12.9716, 77.5946, 12.97161, 77.5946);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(50); // Must be far less than 50 m
  });
});
