import { describe, it, expect } from "vitest";
import {
  applyPagination,
  PAGINATION_DEFAULTS,
} from "../../../src/utils/pagination.js";

// ─── Mock Supabase-like query builder ─────────────────────────────────────────

function makeMockQuery() {
  const calls: Array<[number, number]> = [];
  return {
    range(from: number, to: number) {
      calls.push([from, to]);
      return this;
    },
    getCalls: () => calls,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("applyPagination()", () => {
  describe("correct offset calculation", () => {
    it("page 1, limit 50 → range(0, 49)", () => {
      const q = makeMockQuery();
      applyPagination(q, 1, 50);
      expect(q.getCalls()[0]).toEqual([0, 49]);
    });

    it("page 2, limit 20 → range(20, 39)", () => {
      const q = makeMockQuery();
      applyPagination(q, 2, 20);
      expect(q.getCalls()[0]).toEqual([20, 39]);
    });

    it("page 3, limit 10 → range(20, 29)", () => {
      const q = makeMockQuery();
      applyPagination(q, 3, 10);
      expect(q.getCalls()[0]).toEqual([20, 29]);
    });
  });

  describe("page clamping", () => {
    it("page 0 is clamped to page 1", () => {
      const q = makeMockQuery();
      applyPagination(q, 0, 10);
      // page=0 → || 1 coercion → safePage=1 → offset=0
      expect(q.getCalls()[0]![0]).toBe(0);
    });

    it("negative page is clamped to page 1", () => {
      const q = makeMockQuery();
      applyPagination(q, -5, 10);
      expect(q.getCalls()[0]![0]).toBe(0);
    });
  });

  describe("limit clamping", () => {
    it("limit above MAX_LIMIT is clamped to MAX_LIMIT (100)", () => {
      const q = makeMockQuery();
      applyPagination(q, 1, 200);
      const [from, to] = q.getCalls()[0]!;
      expect(to - from + 1).toBe(PAGINATION_DEFAULTS.MAX_LIMIT);
    });

    it("limit of exactly MAX_LIMIT is accepted", () => {
      const q = makeMockQuery();
      applyPagination(q, 1, PAGINATION_DEFAULTS.MAX_LIMIT);
      expect(q.getCalls()[0]).toEqual([0, PAGINATION_DEFAULTS.MAX_LIMIT - 1]);
    });

    it("limit 0 falls back to default limit (50)", () => {
      const q = makeMockQuery();
      applyPagination(q, 1, 0);
      const [from, to] = q.getCalls()[0]!;
      expect(to - from + 1).toBe(PAGINATION_DEFAULTS.LIMIT);
    });
  });

  describe("string input coercion (defence against query param strings)", () => {
    it('string "2" for page is coerced correctly', () => {
      const q = makeMockQuery();
      // TypeScript signature expects number, but runtime may receive a string
      applyPagination(q, "2" as unknown as number, 10);
      expect(q.getCalls()[0]![0]).toBe(10); // page 2, limit 10 → offset 10
    });

    it('string "50" for limit is coerced correctly', () => {
      const q = makeMockQuery();
      applyPagination(q, 1, "50" as unknown as number);
      expect(q.getCalls()[0]).toEqual([0, 49]);
    });

    it("NaN page falls back to page 1", () => {
      const q = makeMockQuery();
      applyPagination(q, NaN, 10);
      expect(q.getCalls()[0]![0]).toBe(0);
    });
  });

  describe("returns the query (fluent chain)", () => {
    it("returns the same query object for chaining", () => {
      const q = makeMockQuery();
      const result = applyPagination(q, 1, 10);
      expect(result).toBe(q);
    });
  });
});
