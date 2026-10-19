import { defineMessages } from "react-intl";
import { useFormat, useOptionalIntl } from "@/lib/i18n/format";

export type SplitBarRow = { key: string; label: string; rx: number | null; tx: number | null };

const TEXT = defineMessages({
  empty_value: {
    id: "web.common.empty_value",
    defaultMessage: "—",
    description: "Shown in place of a value that is not set",
  },
});

export function SplitBars({ rows, ariaLabel }: { rows: SplitBarRow[]; ariaLabel: string }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const largest = Math.max(0, ...rows.map((row) => (row.rx ?? 0) + (row.tx ?? 0)));
  const share = (bytes: number | null) => (bytes === null || largest === 0 ? 0 : (bytes / largest) * 100);
  const megabytes = (bytes: number | null) =>
    bytes === null ? intl.formatMessage(TEXT.empty_value) : format.number(bytes / 1e6, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  return (
    <ul role="img" aria-label={ariaLabel} className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.key} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate font-mono font-semibold text-foreground">{row.label}</span>
            <span className="shrink-0 font-mono text-muted">
              {intl.formatMessage({ id: "web.components.statistics.split_bars.pair", defaultMessage: "{inbound} / {outbound}", description: "Statistics bandwidth bars: inbound and outbound rates of one node in MB/s, separated by a slash" }, { inbound: megabytes(row.rx), outbound: megabytes(row.tx) })}
            </span>
          </div>
          <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-border/40">
            <span className="min-w-0 rounded-full" style={{ width: `${share(row.rx)}%`, backgroundColor: "var(--chart-inbound)" }} />
            <span className="min-w-0 rounded-full" style={{ width: `${share(row.tx)}%`, backgroundColor: "var(--chart-outbound)" }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
