import { describe, expect, it } from "vitest";
import {
  DEFAULT_RANGE,
  STATISTICS_RANGES,
  formatBits,
  formatByteSize,
  formatRate,
  formatTick,
  isStatisticsRange,
  percent,
  seriesDelta,
  seriesPeak,
} from "./statistics";

describe("statistics formatters", () => {
  it("formats byte rates per second", () => {
    expect(formatRate(0)).toBe("0 B/s");
    expect(formatRate(0.25)).toBe("0 B/s");
    expect(formatRate(2 * 1024 ** 2)).toBe("2.0 MB/s");
  });

  it("formats byte sizes and clamps values below one byte to zero", () => {
    expect(formatByteSize(-5)).toBe("0 B");
    expect(formatByteSize(Number.NaN)).toBe("0 B");
    expect(formatByteSize(2048)).toBe("2.0 KB");
  });

  it("formats bit rates in Mbit/s and Gbit/s", () => {
    expect(formatBits(1_250_000)).toBe("10.0 Mbit/s");
    expect(formatBits(125_000_000)).toBe("1.0 Gbit/s");
  });

  it("returns a percent of capacity, or null without a usable value", () => {
    expect(percent(null, 10)).toBeNull();
    expect(percent(5, 0)).toBeNull();
    expect(percent(5, 20)).toBe(25);
  });

  it("finds the peak sample of a series", () => {
    expect(seriesPeak([])).toBeNull();
    expect(seriesPeak([[1, 5], [2, 9], [3, 7]])).toEqual([2, 9]);
  });

  it("returns the change between the first and last samples", () => {
    expect(seriesDelta([[1, 5]])).toBeNull();
    expect(seriesDelta([[1, 5], [2, 9], [3, 7]])).toBe(2);
  });

  it("exposes the ranges with 24h as the default", () => {
    expect(STATISTICS_RANGES).toEqual(["15m", "1h", "6h", "24h", "7d", "30d"]);
    expect(DEFAULT_RANGE).toBe("24h");
  });

  it("accepts only known ranges", () => {
    expect(isStatisticsRange("1h")).toBe(true);
    expect(isStatisticsRange("2h")).toBe(false);
    expect(isStatisticsRange(7)).toBe(false);
    expect(isStatisticsRange(undefined)).toBe(false);
  });

  it("formats ticks as a clock time up to 24h and as a date beyond", () => {
    expect(formatTick(1_700_000_000, "24h", "en-US")).toMatch(/^\d{2}:\d{2}$/);
    expect(formatTick(1_700_000_000, "30d", "en-US")).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});
