import { formatDateIn, formatTimeIn } from "@/lib/i18n/format";
import { formatBytes } from "@/lib/utils";
import type { StatisticsPoint, StatisticsRange } from "@/types";

export { DEFAULT_RANGE, STATISTICS_RANGES, isStatisticsRange } from "@/lib/statisticsRange";

export function formatByteSize(bytes: number): string {
  return formatBytes(bytes >= 1 ? bytes : 0);
}

export function formatRate(bytesPerSec: number): string {
  return `${formatByteSize(bytesPerSec)}/s`;
}

export function formatBits(bytesPerSec: number): string {
  const megabits = (bytesPerSec * 8) / 1e6;
  if (megabits >= 1000) return `${(megabits / 1000).toFixed(1)} Gbit/s`;
  return `${megabits.toFixed(1)} Mbit/s`;
}

export function percent(used: number | null, capacity: number): number | null {
  if (used === null || capacity <= 0) return null;
  return (used / capacity) * 100;
}

export function seriesPeak(points: StatisticsPoint[]): StatisticsPoint | null {
  return points.reduce<StatisticsPoint | null>((peak, point) => (peak === null || point[1] > peak[1] ? point : peak), null);
}

export function seriesDelta(points: StatisticsPoint[]): number | null {
  if (points.length < 2) return null;
  return points[points.length - 1][1] - points[0][1];
}

export function formatTick(unix: number, range: StatisticsRange, locale: string): string {
  const milliseconds = unix * 1000;
  if (range === "7d" || range === "30d") return formatDateIn(locale, milliseconds, { month: "short", day: "numeric" });
  return formatTimeIn(locale, milliseconds, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}
