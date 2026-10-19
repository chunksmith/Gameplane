import { Fragment, useState } from "react";
import { defineMessages } from "react-intl";
import { formatDateTimeIn, useOptionalIntl } from "@/lib/i18n/format";
import { formatTick } from "@/lib/statistics";
import type { StatisticsRange } from "@/types";

export type HeatmapRow = { key: string; label: string; values: (number | null)[] };

type HeatmapHover = { rowIndex: number; column: number; left: number; top: number };

const LEVELS = [0.12, 0.3, 0.5, 0.7, 0.92];
const TOOLTIP_TIME: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

const TEXT = defineMessages({
  empty_value: {
    id: "web.common.empty_value",
    defaultMessage: "—",
    description: "Shown in place of a value that is not set",
  },
});

function levelOf(value: number, max: number): number {
  const ratio = max > 0 ? Math.max(0, Math.min(value / max, 1)) : 0;
  return Math.min(LEVELS.length - 1, Math.floor(ratio * LEVELS.length));
}

function pairMeans(values: (number | null)[]): (number | null)[] {
  return Array.from({ length: Math.ceil(values.length / 2) }, (_, pair) => {
    const present = values.slice(pair * 2, pair * 2 + 2).filter((value): value is number => value !== null);
    return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0) / present.length;
  });
}

function HeatmapGrid({
  rows,
  buckets,
  range,
  max,
  color,
  formatValue,
}: {
  rows: HeatmapRow[];
  buckets: number[];
  range: StatisticsRange;
  max: number;
  color: string;
  formatValue: (value: number) => string;
}) {
  const intl = useOptionalIntl();
  const [hover, setHover] = useState<HeatmapHover | null>(null);
  const hoveredValue = hover === null ? null : rows[hover.rowIndex].values[hover.column];

  return (
    <div className="relative" onPointerLeave={() => setHover(null)}>
      <div className="grid gap-0.5" style={{ gridTemplateColumns: `auto repeat(${buckets.length}, minmax(0, 1fr))` }}>
        {rows.map((row, rowIndex) => (
          <Fragment key={row.key}>
            <span className="flex items-center whitespace-nowrap pr-2 font-mono text-[11px] text-muted">{row.label}</span>
            {row.values.map((value, column) => (
              <span
                key={column}
                data-row={row.key}
                data-column={column}
                className="h-4 rounded-[3px]"
                style={value === null ? { backgroundColor: "var(--border)", opacity: 0.4 } : { backgroundColor: color, opacity: LEVELS[levelOf(value, max)] }}
                onPointerEnter={(event) =>
                  setHover({
                    rowIndex,
                    column,
                    left: event.currentTarget.offsetLeft + event.currentTarget.offsetWidth / 2,
                    top: event.currentTarget.offsetTop + event.currentTarget.offsetHeight + 4,
                  })
                }
              />
            ))}
          </Fragment>
        ))}
        <span />
        {buckets.map((bucket, column) => (
          <span key={bucket} className="whitespace-nowrap font-mono text-[10px] text-muted">
            {column % 3 === 0 ? formatTick(bucket, range, intl.locale) : null}
          </span>
        ))}
      </div>
      {hover !== null && (
        <div
          className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground shadow-lg"
          style={{ left: hover.left, top: hover.top, transform: `translateX(-${(hover.column / Math.max(1, buckets.length - 1)) * 100}%)` }}
        >
          {intl.formatMessage({ id: "web.components.statistics.heatmap.cell_tooltip", defaultMessage: "{node} at {time}: {value}", description: "Statistics heatmap: tooltip over one cell, naming the node, the time bucket and the value" }, {
            node: rows[hover.rowIndex].label,
            time: formatDateTimeIn(intl.locale, buckets[hover.column] * 1000, TOOLTIP_TIME),
            value: hoveredValue === null ? intl.formatMessage(TEXT.empty_value) : formatValue(hoveredValue),
          })}
        </div>
      )}
    </div>
  );
}

export function Heatmap({
  rows,
  buckets,
  range,
  max,
  color,
  formatValue,
  legendLabel,
  ariaLabel,
}: {
  rows: HeatmapRow[];
  buckets: number[];
  range: StatisticsRange;
  max: number;
  color: string;
  formatValue: (value: number) => string;
  legendLabel: string;
  ariaLabel: string;
}) {
  const intl = useOptionalIntl();
  const mergedRows = rows.map((row) => ({ ...row, values: pairMeans(row.values) }));
  const mergedBuckets = buckets.filter((_, index) => index % 2 === 0);

  return (
    <div>
      <div>
        <div role="img" aria-label={ariaLabel}>
          <div className="hidden sm:block">
            <HeatmapGrid rows={rows} buckets={buckets} range={range} max={max} color={color} formatValue={formatValue} />
          </div>
          <div className="sm:hidden">
            <HeatmapGrid rows={mergedRows} buckets={mergedBuckets} range={range} max={max} color={color} formatValue={formatValue} />
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-1.5 font-mono text-[10px] text-muted">
        <span>{formatValue(0)}</span>
        {LEVELS.map((level) => (
          <span key={level} className="h-2.5 w-4 rounded-[2px]" style={{ backgroundColor: color, opacity: level }} />
        ))}
        <span>{intl.formatMessage({ id: "web.components.statistics.heatmap.legend_top", defaultMessage: "{value}+ {unit}", description: "Statistics heatmap: last legend label, the top of the scale followed by the metric unit" }, { value: formatValue(max), unit: legendLabel })}</span>
      </div>
    </div>
  );
}
