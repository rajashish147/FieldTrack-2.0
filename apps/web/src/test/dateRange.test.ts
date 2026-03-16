import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  todayRange,
  yesterdayRange,
  lastNDaysRange,
  thisMonthRange,
  lastMonthRange,
  thisWeekRange,
  rangeForPreset,
  toInputDate,
} from "@/lib/dateRange";

describe("dateRange utilities", () => {
  // Pin clock to a Wednesday 2026-03-18T12:00:00 UTC (local = UTC for tests)
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("todayRange: from is today 00:00, to is now", () => {
    const { from, to } = todayRange();
    expect(new Date(from).getDate()).toBe(new Date().getDate());
    expect(new Date(from).getHours()).toBe(0);
    expect(new Date(to).toISOString()).toBe(new Date().toISOString());
  });

  it("yesterdayRange: from is yesterday 00:00, to is yesterday 23:59:59.999", () => {
    const { from, to } = yesterdayRange();
    const yesterday = new Date("2026-03-17");
    expect(new Date(from).getDate()).toBe(17);
    expect(new Date(to).getDate()).toBe(17);
    expect(new Date(to).getHours()).toBe(23);
  });

  it("lastNDaysRange(7): spans 7 calendar days", () => {
    const { from, to } = lastNDaysRange(7);
    const fromDate = new Date(from);
    const toDate = new Date(to);
    // Compare calendar dates (strip time) so the assertion is timezone-agnostic
    const fromDay = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
    const toDay   = new Date(toDate.getFullYear(),   toDate.getMonth(),   toDate.getDate());
    const diffDays = (toDay.getTime() - fromDay.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBe(6); // from day-6 to now = 7 calendar days inclusive
  });

  it("thisMonthRange: from is the 1st of the month", () => {
    const { from } = thisMonthRange();
    expect(new Date(from).getDate()).toBe(1);
    expect(new Date(from).getMonth()).toBe(2); // March = 2 (0-indexed)
  });

  it("lastMonthRange: covers February 2026 entirely", () => {
    const { from, to } = lastMonthRange();
    expect(new Date(from).getMonth()).toBe(1); // February
    expect(new Date(from).getDate()).toBe(1);
    expect(new Date(to).getDate()).toBe(28); // Feb 2026 has 28 days
  });

  it("thisWeekRange: from is Monday", () => {
    // 2026-03-18 is a Wednesday → Monday is 2026-03-16
    const { from } = thisWeekRange();
    const monday = new Date(from);
    expect(monday.getDay()).toBe(1); // Monday
    expect(monday.getDate()).toBe(16);
  });

  it("rangeForPreset('today') delegates to todayRange", () => {
    const r = rangeForPreset("today");
    const direct = todayRange();
    expect(r.from).toBe(direct.from);
  });

  it("toInputDate formats as YYYY-MM-DD", () => {
    expect(toInputDate(new Date("2026-03-18T12:00:00Z"))).toBe("2026-03-18");
  });
});
