import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { defineMessages } from "react-intl";
import { formatDateTimeIn, useOptionalIntl } from "@/lib/i18n/format";
import { formatTick } from "@/lib/statistics";
import { cn } from "@/lib/utils";
import type { StatisticsPoint, StatisticsRange } from "@/types";

export type Series = { key: string; label: string; color: string; points: StatisticsPoint[]; area?: boolean };
export type Threshold = { key: string; label: string; value: number; color: string; dashed?: boolean };

const TEXT = defineMessages({
  no_data: {
    id: "web.components.statistics.line_chart.no_data",
    defaultMessage: "No data for this range",
    description: "Statistics line chart: shown in the empty chart box when the selected range has no samples",
  },
  now: {
    id: "web.components.statistics.line_chart.now",
    defaultMessage: "now",
    description: "Statistics line chart: label of the last time tick when that tick is the current time",
  },
});

const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
const TICK_INDEXES = [0, 1, 2, 3, 4];
const TOOLTIP_TIME: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = NICE_STEPS.find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

function nearestPoint(points: StatisticsPoint[], target: number): StatisticsPoint {
  return points.reduce((best, point) => (Math.abs(point[0] - target) < Math.abs(best[0] - target) ? point : best));
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

export function LineChart({
  series,
  thresholds = [],
  range,
  formatValue,
  yMax,
  unitBase = 1,
  height = 180,
  ariaLabel,
}: {
  series: Series[];
  thresholds?: Threshold[];
  range: StatisticsRange;
  formatValue: (value: number) => string;
  yMax?: number;
  unitBase?: number;
  height?: number;
  ariaLabel: string;
}) {
  const intl = useOptionalIntl();
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const populated = series.filter((item) => item.points.length > 0);
  if (populated.length === 0) {
    return (
      <div role="img" aria-label={ariaLabel} className="flex items-center justify-center rounded-md border border-dashed border-border text-xs text-muted" style={{ height }}>
        {intl.formatMessage(TEXT.no_data)}
      </div>
    );
  }

  const allPoints = populated.flatMap((item) => item.points);
  const times = allPoints.map((point) => point[0]);
  const xMin = Math.min(...times);
  const xMax = Math.max(...times, xMin + 1);
  const top = niceCeiling((yMax ?? Math.max(0, ...allPoints.map((point) => point[1]), ...thresholds.map((threshold) => threshold.value))) / unitBase) * unitBase;
  const gridValues = TICK_INDEXES.map((index) => (top * index) / 4);
  const xPercent = (time: number) => ((time - xMin) / (xMax - xMin)) * 100;
  const yPercent = (value: number) => 100 - (value / top) * 100;
  const linePath = (points: StatisticsPoint[]) =>
    points.map(([time, value], index) => `${index === 0 ? "M" : "L"}${xPercent(time).toFixed(2)} ${yPercent(value).toFixed(2)}`).join(" ");
  const areaPath = (points: StatisticsPoint[]) =>
    `${linePath(points)} L${xPercent(points[points.length - 1][0]).toFixed(2)} 100 L${xPercent(points[0][0]).toFixed(2)} 100 Z`;
  const longest = populated.reduce((best, item) => (item.points.length > best.points.length ? item : best));
  const step = longest.points.length > 1 ? (xMax - xMin) / (longest.points.length - 1) : 0;
  const showNow = nowSeconds() - xMax <= 2 * step;
  const hovered: { item: Series; point: StatisticsPoint }[] = hoverTime === null ? [] : populated.map((item) => ({ item, point: nearestPoint(item.points, hoverTime) }));

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    setHoverTime(nearestPoint(allPoints, xMin + fraction * (xMax - xMin))[0]);
  };

  return (
    <div role="img" aria-label={ariaLabel} className="relative w-full" style={{ height }}>
      <div className="absolute bottom-5 left-0 top-0 w-11">
        {gridValues.map((value, index) => (
          <span key={index} className="absolute right-2 translate-y-1/2 whitespace-nowrap font-mono text-[10px] text-muted" style={{ bottom: `${index * 25}%` }}>
            {formatValue(value)}
          </span>
        ))}
      </div>
      <div className="absolute bottom-5 left-11 right-0 top-0" onPointerMove={handlePointerMove} onPointerLeave={() => setHoverTime(null)}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-hidden" aria-hidden="true">
          {gridValues.map((value, index) => (
            <line key={index} x1={0} x2={100} y1={yPercent(value)} y2={yPercent(value)} strokeWidth={1} vectorEffect="non-scaling-stroke" style={{ stroke: "var(--border)" }} />
          ))}
          {populated.filter((item) => item.area).map((item) => (
            <path key={item.key} d={areaPath(item.points)} fillOpacity={0.12} stroke="none" style={{ fill: item.color }} />
          ))}
          {thresholds.map((threshold) => (
            <line
              key={threshold.key}
              x1={0}
              x2={100}
              y1={yPercent(threshold.value)}
              y2={yPercent(threshold.value)}
              strokeWidth={2}
              strokeDasharray={threshold.dashed ? "6 4" : undefined}
              vectorEffect="non-scaling-stroke"
              style={{ stroke: threshold.color }}
            />
          ))}
          {populated.map((item) => (
            <path key={item.key} d={linePath(item.points)} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={{ stroke: item.color }} />
          ))}
        </svg>
        {hoverTime !== null && (
          <>
            <span className="pointer-events-none absolute inset-y-0 w-px bg-border" style={{ left: `${xPercent(hoverTime)}%` }} />
            {hovered.map(({ item, point }) => (
              <span
                key={item.key}
                className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ left: `${xPercent(point[0])}%`, top: `${yPercent(point[1])}%`, backgroundColor: item.color }}
              />
            ))}
            <div
              className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-lg"
              style={{ left: `${xPercent(hoverTime)}%`, transform: xPercent(hoverTime) > 50 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
            >
              <div className="font-mono text-[10px] text-muted">{formatDateTimeIn(intl.locale, hoverTime * 1000, TOOLTIP_TIME)}</div>
              {hovered.map(({ item, point }) => (
                <div key={item.key} className="mt-1 flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-muted">
                    <span aria-hidden="true" className="size-2 rounded-sm" style={{ backgroundColor: item.color }} />
                    {item.label}
                  </span>
                  <span className="font-mono text-foreground">{formatValue(point[1])}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="absolute bottom-0 left-11 right-0 h-5">
        {TICK_INDEXES.map((index) => {
          const time = xMin + ((xMax - xMin) * index) / 4;
          return (
            <span key={index} className="absolute top-0 whitespace-nowrap font-mono text-[10px] text-muted" style={{ left: `${index * 25}%`, transform: `translateX(-${index * 25}%)` }}>
              {index === 4 && showNow ? intl.formatMessage(TEXT.now) : formatTick(time, range, intl.locale)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function ChartLegend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn("shrink-0", item.dashed ? "h-0 w-3 border-t-2 border-dashed" : "size-2 rounded-sm")}
            style={item.dashed ? { borderColor: item.color } : { backgroundColor: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
