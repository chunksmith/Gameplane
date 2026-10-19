import type { StatisticsRange } from "@/types";

export const STATISTICS_RANGES: StatisticsRange[] = ["15m", "1h", "6h", "24h", "7d", "30d"];
export const DEFAULT_RANGE: StatisticsRange = "24h";

export function isStatisticsRange(value: unknown): value is StatisticsRange {
  return STATISTICS_RANGES.some((range) => range === value);
}
